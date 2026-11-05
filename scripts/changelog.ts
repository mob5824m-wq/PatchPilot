#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommit, renderNotes, type ParsedCommit } from './conventional.ts';

/**
 * Regenerates CHANGELOG.md from the same conventional commits the release
 * workflow uses, so the file and the GitHub releases never disagree.
 *
 *   npm run changelog        # writes CHANGELOG.md
 *   npm run changelog -- --check   # exits 1 when the file is out of date
 *
 * One section per tag, newest first. Commits before the first tag are listed as
 * "Unreleased", which is what a checkout without tags looks like.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function tags(): { tag: string; date: string }[] {
  try {
    const raw = git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%1f%(creatordate:short)', 'refs/tags']);
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [tag = '', date = ''] = line.split('\x1f');
        return { tag, date };
      })
      .filter((entry) => /^v\d/.test(entry.tag));
  } catch {
    return [];
  }
}

function commits(range: string): ParsedCommit[] {
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range]);
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', subject = '', body = ''] = chunk.split('\x1f');
      return parseCommit({ hash: hash.trim(), subject: subject.trim(), body: body.trim() });
    })
    .filter((entry): entry is ParsedCommit => entry !== null);
}

function build(): string {
  const list = tags();
  const lines: string[] = ['# Changelog', '', 'Generated from conventional commits by `npm run changelog` — do not edit by hand.', ''];

  if (!list.length) {
    const unreleased = commits('HEAD');
    lines.push('## Unreleased', '');
    lines.push(unreleased.length ? renderNotes(unreleased) : 'Nothing yet.', '');
    return lines.join('\n');
  }

  for (const [index, entry] of list.entries()) {
    const previous = list[index + 1]?.tag;
    const parsed = commits(previous ? `${previous}..${entry.tag}` : entry.tag);
    lines.push(`## ${entry.tag} — ${entry.date}`, '');
    lines.push(parsed.length ? renderNotes(parsed) : 'No user-facing changes.', '');
  }

  // Anything since the newest tag belongs to the next release.
  const unreleased = commits(`${list[0]!.tag}..HEAD`);
  if (unreleased.length) {
    lines.push('## Unreleased', '', renderNotes(unreleased), '');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const target = join(root, 'CHANGELOG.md');
const content = build();

if (process.argv.includes('--check')) {
  const { readFileSync } = await import('node:fs');
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // Missing counts as out of date.
  }
  if (current.trim() !== content.trim()) {
    console.error('CHANGELOG.md is out of date. Run `npm run changelog`.');
    process.exit(1);
  }
  console.log('CHANGELOG.md is up to date.');
} else {
  writeFileSync(target, content, 'utf8');
  console.log(`Wrote ${target}`);
}
