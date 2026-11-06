/**
 * Version strings in patch bundles are app-specific: `21.43.523`, `26.30.05`,
 * `a3.77.2`, `1.791.265`, `407.0.0.178994`, even `Android V1.79.3`. They are
 * compared segment by segment, numerically when a segment is a number, so
 * `21.9` sorts below `21.10` (which a plain string compare gets wrong).
 */

function split(version: string): string[] {
  return version
    .replace(/^[^\d]*/i, '')
    .split(/[.\-+_\s]+/)
    .filter((part) => part.length > 0);
}

function isNumeric(part: string): boolean {
  return /^\d+$/.test(part);
}

export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;

    const lNumeric = isNumeric(l);
    const rNumeric = isNumeric(r);
    if (lNumeric && rNumeric) {
      const lv = BigInt(l);
      const rv = BigInt(r);
      if (lv !== rv) return lv < rv ? -1 : 1;
      continue;
    }
    if (lNumeric !== rNumeric) {
      // A numeric segment sorts above an alphanumeric one ("1.2" > "1.beta").
      return lNumeric ? 1 : -1;
    }
    const numericPrefix = (value: string): [bigint, string] => {
      const match = /^(\d*)(.*)$/.exec(value)!;
      return [match[1] ? BigInt(match[1]) : 0n, match[2]];
    };
    const [lPrefix, lRest] = numericPrefix(l);
    const [rPrefix, rRest] = numericPrefix(r);
    if (lPrefix !== rPrefix) return lPrefix < rPrefix ? -1 : 1;
    const comparison = lRest.localeCompare(rRest);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

const EXPERIMENTAL_HINTS = /(?:^|[.\-_])(?:dev|beta|alpha|rc|preview|nightly|canary)\d*(?:[.\-_]|$)/i;

/** A version string that looks like a pre-release, used as a last-resort hint. */
export function looksExperimental(version: string): boolean {
  return EXPERIMENTAL_HINTS.test(version);
}
