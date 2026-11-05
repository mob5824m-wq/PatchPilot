/**
 * Conventional-commit reading, version arithmetic and release-note grouping.
 *
 * Kept free of git and filesystem calls so the release rules can be tested
 * directly: `test/version.test.ts` feeds in commit subjects and asserts what
 * the next version would be.
 */

export type Bump = 'none' | 'patch' | 'minor' | 'major';
export type Semver = { major: number; minor: number; patch: number };

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export interface ParsedCommit extends Commit {
  /** `feat`, `fix`, `chore`, … or `other` for a message that follows no convention. */
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

/** Commit types that, on their own, never justify a release. */
const SILENT_TYPES = new Set(['chore', 'docs', 'style', 'test', 'ci', 'build', 'release']);

const HEADER = /^([a-zA-Z]+)(?:\((.*?)\))?(!)?:\s*(.+)$/;

/** Merge commits and release bump commits are bookkeeping, not changes. */
function isNoise(subject: string): boolean {
  return /^Merge (pull request|branch|remote-tracking branch)\b/i.test(subject) || /^Revert "Merge /i.test(subject);
}

export function parseCommit(commit: Commit): ParsedCommit | null {
  if (isNoise(commit.subject)) return null;

  const match = HEADER.exec(commit.subject.trim());
  if (!match) {
    // Unconventional commit: still a change to the code, so treat it as a fix
    // rather than silently dropping it from the next release.
    return {
      ...commit,
      type: 'other',
      scope: null,
      breaking: false,
      description: commit.subject.trim(),
    };
  }

  const type = (match[1] ?? '').toLowerCase();
  const breaking = Boolean(match[3]) || /BREAKING[ -]CHANGE:/i.test(commit.body);
  return {
    ...commit,
    type,
    scope: match[2]?.trim() || null,
    breaking,
    description: (match[4] ?? '').trim(),
  };
}

/** The bump a single commit asks for. */
export function bumpForCommit(commit: ParsedCommit): Bump {
  if (commit.breaking) return 'major';
  if (commit.type === 'feat') return 'minor';
  if (commit.type === 'other' || commit.type === 'fix' || commit.type === 'perf' || commit.type === 'revert') {
    return 'patch';
  }
  return SILENT_TYPES.has(commit.type) ? 'none' : 'none';
}

const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function maxBump(bumps: Bump[]): Bump {
  return bumps.reduce<Bump>((highest, bump) => (RANK[bump] > RANK[highest] ? bump : highest), 'none');
}

/** The bump a whole release worth of commits asks for. */
export function releaseBump(subjects: Commit[]): { bump: Bump; commits: ParsedCommit[] } {
  const commits = subjects.map(parseCommit).filter((entry): entry is ParsedCommit => entry !== null);
  return { bump: maxBump(commits.map(bumpForCommit)), commits };
}

export function parseSemver(text: string): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim().replace(/^v/i, ''));
  if (!match) throw new Error(`Not a version: ${text}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Applies a bump. Below 1.0.0 a breaking change only moves the minor version,
 * which is what semantic-release and most pre-1.0 projects do — a 0.x release
 * is not a stability promise yet.
 */
export function bumpVersion(current: string, bump: Bump): string {
  const version = parseSemver(current);
  if (bump === 'none') return formatSemver(version);
  if (bump === 'major') {
    return version.major === 0
      ? `${version.major}.${version.minor + 1}.0`
      : `${version.major + 1}.0.0`;
  }
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`;
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

/** Compares two versions, newest last: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

const SECTIONS: { title: string; types: string[] }[] = [
  { title: 'Features', types: ['feat'] },
  { title: 'Fixes', types: ['fix', 'perf', 'revert'] },
  { title: 'Documentation', types: ['docs'] },
  { title: 'Build and tooling', types: ['build', 'ci', 'chore', 'release', 'style', 'test'] },
];

function heading(commit: ParsedCommit): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  return `- ${scope}${commit.description} (${commit.hash.slice(0, 7)})`;
}

/** Markdown release notes: breaking changes first, then grouped by type. */
export function renderNotes(commits: ParsedCommit[], options: { compareUrl?: string } = {}): string {
  const lines: string[] = [];
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length) {
    lines.push('### Breaking changes', '');
    lines.push(...breaking.map(heading), '');
  }

  const seen = new Set<string>();
  for (const section of SECTIONS) {
    const entries = commits.filter((commit) => section.types.includes(commit.type) && !seen.has(commit.hash));
    if (!entries.length) continue;
    for (const entry of entries) seen.add(entry.hash);
    lines.push(`### ${section.title}`, '', ...entries.map(heading), '');
  }

  const rest = commits.filter((commit) => !seen.has(commit.hash));
  if (rest.length) lines.push('### Other changes', '', ...rest.map(heading), '');

  if (options.compareUrl) lines.push(`**Full changelog:** ${options.compareUrl}`);
  return lines.join('\n').trim();
}
