/**
 * Turns what Morphe's "Patch sources" screen shows into bundle references.
 *
 * Morphe lists the sources you added as GitHub repositories (`owner/repo`, often
 * shown as a full URL) or as local bundle files. PatchPilot can mirror the first
 * kind exactly; a local file has to be handed over with the file picker because
 * only Morphe can read its own copy.
 */

export type BundleSourceKind = 'github' | 'name';

export interface BundleSourceRef {
  kind: BundleSourceKind;
  /** `owner/repo` for kind `github`, the bundle's display name for kind `name`. */
  value: string;
}

export interface ParsedSources {
  entries: BundleSourceRef[];
  /** Lines that could not be turned into a bundle, with the reason to show. */
  skipped: { source: string; reason: string }[];
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function isShorthand(value: string): boolean {
  // The dash goes last in each class: `_.-/` would read as a range and quietly
  // reject every name with a hyphen in it.
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*$/.test(value);
}

/** One line from a pasted list. Returns a reason when it cannot be used. */
export function parseBundleSource(input: string): BundleSourceRef | { error: string } | null {
  const raw = input
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!raw) return null;
  if (raw.startsWith('#')) return null;

  const github = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/#?].*)?$/i);
  if (github) return { kind: 'github', value: `${github[1]}/${stripGitSuffix(github[2]!)}` };

  if (/^https?:\/\//i.test(raw)) {
    return {
      error: 'Only GitHub repositories can be imported — download the file and load it with "Load a .mpp file" instead.',
    };
  }

  // A bare path is only a repository when both halves look like name segments;
  // `patches.json` or `my-bundle.mpp` is a file name, which has no owner.
  if (isShorthand(raw)) {
    const [owner, repo] = raw.split('/');
    if (owner && repo && !/\.(mpp|json|zip)$/i.test(raw)) {
      return { kind: 'github', value: `${owner}/${stripGitSuffix(repo)}` };
    }
  }

  // Anything else without a slash is treated as a bundle *name*, which is how
  // Morphe shows a locally added bundle ("Morphe Patches"). Getting the name
  // wrong is harmless — the import reports it instead of inventing a repo.
  if (/\.(mpp|json|zip)$/i.test(raw)) {
    return { error: 'That is a file name, not a bundle source — load it with "Load a .mpp file" instead.' };
  }

  if (!raw.includes('/')) {
    return { kind: 'name', value: raw };
  }

  return { error: 'Not a repository name or URL this can import.' };
}

/** Parses a pasted block of sources, keeping the order and dropping repeats. */
export function parseBundleSources(text: string): ParsedSources {
  const entries: BundleSourceRef[] = [];
  const skipped: { source: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseBundleSource(line);
    if (!parsed) continue;
    if ('error' in parsed) {
      skipped.push({ source: line.trim(), reason: parsed.error });
      continue;
    }
    const key = `${parsed.kind}:${parsed.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(parsed);
  }

  return { entries, skipped };
}
