#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bumpVersion,
  compareVersions,
  releaseBump,
  renderNotes,
  parseSemver,
  formatSemver,
  type Bump,
  type Commit,
} from './conventional.ts';

/**
 * Works out the version the next release should carry and writes its notes.
 *
 *   tsx scripts/next-version.ts --current 0.1.0 --range v0.1.0..HEAD
 *   tsx scripts/next-version.ts --bump minor --notes-out notes.md
 *
 * Prints JSON on stdout so a workflow can read it with `jq`:
 *   { "current": "0.1.0", "version": "0.2.0", "tag": "v0.2.0",
 *     "bump": "minor", "release": true, "commits": 4 }
 *
 * Exit code is always 0: "no release-worthy commits" is a normal outcome, and
 * `"release": false` says so.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  current: string | null;
  range: string | null;
  bump: Bump | 'auto';
  notesOut: string | null;
  prefix: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { current: null, range: null, bump: 'auto', notesOut: null, prefix: 'v' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [name, inline] = argument.slice(2).split('=');
    const value = inline ?? argv[index + 1];
    if (inline === undefined && (value === undefined || value.startsWith('--'))) {
      throw new Error(`--${name} needs a value`);
    }
    if (inline === undefined) index += 1;
    switch (name) {
      case 'current':
        options.current = value?.trim() || null;
        break;
      case 'range':
        options.range = value?.trim() || null;
        break;
      case 'bump':
        if (value !== 'auto' && value !== 'none' && value !== 'patch' && value !== 'minor' && value !== 'major') {
          throw new Error(`Unknown bump: ${value}`);
        }
        options.bump = value;
        break;
      case 'notes-out':
        options.notesOut = value ?? null;
        break;
      case 'prefix':
        options.prefix = value ?? 'v';
        break;
      default:
        throw new Error(`Unknown flag: --${name}`);
    }
  }
  return options;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function lastTag(prefix: string): string | null {
  try {
    const tag = git(['describe', '--tags', '--abbrev=0', '--match', `${prefix}*`]).trim();
    return tag || null;
  } catch {
    return null;
  }
}

/** Commits reachable from `range`, newest first. Record separator keeps bodies intact. */
function readCommits(range: string | null): Commit[] {
  const spec = range ?? 'HEAD';
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', spec]);
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', subject = '', body = ''] = chunk.split('\x1f');
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    })
    .filter((commit) => commit.hash.length > 0);
}

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const tag = lastTag(options.prefix);
  const current = options.current ?? (tag ? tag.slice(options.prefix.length) : packageVersion());
  const range = options.range ?? (tag ? `${tag}..HEAD` : 'HEAD');
  const commits = readCommits(range);

  const { bump: detected, commits: parsed } = releaseBump(commits);
  const bump: Bump = options.bump === 'auto' ? detected : options.bump;
  const release = bump !== 'none' && parsed.length > 0;

  const version = release ? bumpVersion(current, bump) : formatSemver(parseSemver(current));
  if (compareVersions(version, current) < 0) throw new Error(`Refusing to go backwards: ${current} → ${version}`);

  if (options.notesOut) {
    const previous = `${options.prefix}${formatSemver(parseSemver(current))}`;
    const compareUrl =
      process.env.GITHUB_REPOSITORY && release
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/compare/${previous}...${options.prefix}${version}`
        : undefined;
    const notes = renderNotes(parsed, { compareUrl });
    const body = release
      ? notes
      : 'No user-facing changes since the last release (only chores, docs, tests or CI).';
    writeFileSync(resolve(options.notesOut), `${body}\n`, 'utf8');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        current: formatSemver(parseSemver(current)),
        version,
        tag: `${options.prefix}${version}`,
        bump,
        detected,
        release,
        commits: parsed.length,
      },
      null,
      2,
    )}\n`,
  );
}

main();
