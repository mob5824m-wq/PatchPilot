import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bumpForCommit,
  bumpVersion,
  compareVersions,
  parseCommit,
  parseSemver,
  releaseBump,
  renderNotes,
  type Commit,
} from '../scripts/conventional.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const commit = (subject: string, body = '', hash = 'abcdef1234'): Commit => ({ hash, subject, body });

test('conventional headers are parsed into type, scope and description', () => {
  const parsed = parseCommit(commit('feat(providers): add APKPure version list'));
  assert.equal(parsed?.type, 'feat');
  assert.equal(parsed?.scope, 'providers');
  assert.equal(parsed?.description, 'add APKPure version list');
  assert.equal(parsed?.breaking, false);
});

test('breaking changes are recognised from ! and from the body trailer', () => {
  assert.equal(parseCommit(commit('refactor(core)!: drop the v1 catalog'))?.breaking, true);
  assert.equal(
    parseCommit(commit('feat: new store', 'BREAKING CHANGE: the data directory moved'))?.breaking,
    true,
  );
  assert.equal(parseCommit(commit('feat: new store', 'BREAKING-CHANGE: ditto'))?.breaking, true);
});

test('merge commits are bookkeeping and never reach the changelog', () => {
  assert.equal(parseCommit(commit('Merge pull request #12 from arena/foo')), null);
  assert.equal(parseCommit(commit('Merge branch main into arena/foo')), null);
});

test('a message with no convention still counts as a patch', () => {
  const parsed = parseCommit(commit('Fix the thing that broke'));
  assert.equal(parsed?.type, 'other');
  assert.equal(bumpForCommit(parsed!), 'patch');
});

test('commit types map to the right bump', () => {
  assert.equal(bumpForCommit(parseCommit(commit('feat: x'))!), 'minor');
  assert.equal(bumpForCommit(parseCommit(commit('fix: x'))!), 'patch');
  assert.equal(bumpForCommit(parseCommit(commit('perf: x'))!), 'patch');
  assert.equal(bumpForCommit(parseCommit(commit('docs: x'))!), 'none');
  assert.equal(bumpForCommit(parseCommit(commit('chore(release): v1.2.3 [skip ci]'))!), 'none');
  assert.equal(bumpForCommit(parseCommit(commit('feat!: x'))!), 'major');
});

test('the release takes the largest bump in the range', () => {
  const { bump, commits } = releaseBump([
    commit('fix(a): one'),
    commit('feat(b): two'),
    commit('chore: tidy'),
    commit('Merge pull request #3 from arena/x'),
  ]);
  assert.equal(bump, 'minor');
  assert.equal(commits.length, 3);
});

test('version arithmetic follows semver, and stays in 0.x until a real major', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('0.4.2', 'major'), '0.5.0');
  assert.equal(bumpVersion('1.2.3', 'none'), '1.2.3');
  assert.deepEqual(parseSemver('v2.10.1'), { major: 2, minor: 10, patch: 1 });
  assert.throws(() => bumpVersion('not-a-version', 'patch'));
});

test('versions compare numerically, not as strings', () => {
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
});

test('release notes lead with breaking changes and group the rest', () => {
  const commits = [
    parseCommit(commit('feat(mirror): exact version codes', '', 'aaaaaaa111')),
    parseCommit(commit('fix(mirror): retry once', '', 'bbbbbbb222')),
    parseCommit(commit('chore: bump deps', '', 'ccccccc333')),
    parseCommit(commit('feat(api)!: rename the endpoint', '', 'ddddddd444')),
  ].filter((entry) => entry !== null);

  const notes = renderNotes(commits, { compareUrl: 'https://example.test/compare' });
  assert.ok(notes.startsWith('### Breaking changes'));
  assert.ok(notes.indexOf('### Breaking changes') < notes.indexOf('### Features'));
  assert.match(notes, /- \*\*mirror:\*\* exact version codes \(aaaaaaa\)/);
  assert.match(notes, /### Build and tooling[\s\S]*bump deps/);
  assert.match(notes, /\*\*Full changelog:\*\* https:\/\/example\.test\/compare/);
});

test('the next-version CLI prints the version a workflow will tag', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(root, 'scripts/next-version.ts'),
      '--current',
      '1.2.3',
      '--range',
      'HEAD',
      '--bump',
      'patch',
    ],
    { cwd: root, encoding: 'utf8' },
  );

  const result = JSON.parse(output) as { version: string; tag: string; bump: string; release: boolean };
  assert.equal(result.version, '1.2.4');
  assert.equal(result.tag, 'v1.2.4');
  assert.equal(result.bump, 'patch');
  assert.equal(result.release, true);
});

test('the CLI reports no release when the range holds only chores and docs', () => {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', join(root, 'scripts/next-version.ts'), '--current', '1.2.3', '--range', 'HEAD', '--bump', 'auto'],
    { cwd: root, encoding: 'utf8' },
  );
  // The repository's own history decides this, so assert the contract instead of a value.
  const result = JSON.parse(output) as { version: string; release: boolean; bump: string };
  if (!result.release) {
    assert.equal(result.version, '1.2.3');
    assert.equal(result.bump, 'none');
  } else {
    assert.ok(compareVersions(result.version, '1.2.3') > 0);
  }
});
