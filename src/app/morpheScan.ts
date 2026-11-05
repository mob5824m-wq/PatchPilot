import { importBundleSources, type BundleImportOutcome } from '../shared/bundleImport.ts';
import type { MorpheFileContents, MorpheScan } from './native.ts';

/**
 * Reads Morphe Manager's patch sources off the device.
 *
 * The shell can only see what Android lets it see: Morphe's install, the shared
 * folders it may write to, and — on a rooted device — its private directories.
 * This module turns whatever comes back into bundles: a `.mpp` or a
 * `patches-list.json` becomes a loaded bundle, and a preferences file is read for
 * repository URLs, which are then matched against bundles PatchPilot knows.
 *
 * Nothing here guesses. If the scan cannot reach Morphe's own settings (the
 * normal case on Android 11 and later) the outcome says so, and the manual
 * import stays the way in.
 */

/** What a scan needs from the shell; faked in tests. */
export interface MorpheReader {
  scan(): Promise<MorpheScan>;
  read(path: string): Promise<MorpheFileContents>;
}

/** What a discovery needs from the bundle store; faked in tests. */
export interface MorpheBundleSink {
  configs(): { id: string; name: string; repo?: string; enabled: boolean }[];
  enable(id: string): Promise<void>;
  addRepo(repo: string): Promise<void>;
  addArchive(name: string, bytes: Uint8Array): Promise<string>;
  addPatchList(name: string, patchesList: unknown): Promise<string>;
}

export interface MorpheDiscovery {
  scannedAt: string;
  installed: { package: string; version: string | null }[];
  /** Files that were actually read, out of the ones the scan listed. */
  filesRead: number;
  /** Repository URLs found in Morphe's own files. */
  sources: string[];
  /** Bundles that were already known and got switched on. */
  enabled: string[];
  /** Bundles that had to be added (a repository or a file). */
  added: string[];
  /** Why something was skipped, in the words the UI will show. */
  notes: string[];
  /** True when anything at all came back from Morphe. */
  found: boolean;
}

const MAX_READS = 12;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

function asJson(bytes: Uint8Array): unknown {
  const text = asText(bytes).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A patch list is the one thing every bundle format agrees on. */
export function looksLikePatchList(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const patches = (value as { patches?: unknown }).patches;
  return Array.isArray(patches) && patches.length > 0;
}

/**
 * Repository URLs in a Morphe preferences file. Flutter's shared_preferences
 * escapes slashes (`https:\/\/github.com\/owner\/repo`), so both spellings are
 * normalised before matching.
 */
export function reposIn(text: string): string[] {
  const normalised = text.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const found = new Set<string>();
  for (const match of normalised.matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi)) {
    const owner = match[1]!;
    const repo = match[2]!.replace(/\.git$/i, '');
    if (!owner || !repo) continue;
    if (repo.toLowerCase() === 'releases' || repo.toLowerCase() === 'blob') continue;
    found.add(`${owner}/${repo}`);
  }
  return [...found];
}

/** Runs one scan and applies everything it found. Never throws for a single file. */
export async function discoverMorphe(reader: MorpheReader, sink: MorpheBundleSink): Promise<MorpheDiscovery> {
  const scan = await reader.scan();
  const notes = [...(scan.notes ?? [])];
  const sources = new Set<string>();
  const added: string[] = [];
  const enabled: string[] = [];
  let filesRead = 0;

  for (const file of scan.files ?? []) {
    if (filesRead >= MAX_READS) {
      notes.push(`Stopped after ${MAX_READS} files.`);
      break;
    }
    if (file.sizeBytes > MAX_FILE_BYTES) continue;

    let contents: MorpheFileContents;
    try {
      contents = await reader.read(file.path);
    } catch (cause) {
      notes.push(`${file.name}: ${(cause as Error).message}`);
      continue;
    }

    const bytes = decodeBase64(contents.base64);
    filesRead += 1;

    if (file.kind === 'bundle' || /\.mpp$/i.test(file.name)) {
      try {
        added.push(await sink.addArchive(file.name, bytes));
        continue;
      } catch (cause) {
        notes.push(`${file.name}: ${(cause as Error).message}`);
        continue;
      }
    }

    const parsed = asJson(bytes);
    if (looksLikePatchList(parsed)) {
      try {
        added.push(await sink.addPatchList(file.name, parsed));
        continue;
      } catch (cause) {
        notes.push(`${file.name}: ${(cause as Error).message}`);
        continue;
      }
    }

    for (const repo of reposIn(asText(bytes))) sources.add(repo);
  }

  // Morphe's settings name repositories; each is applied on its own so one dead
  // link cannot take the rest of the import down with it.
  for (const repo of sources) {
    try {
      const outcome: BundleImportOutcome = await importBundleSources(repo, {
        configs: () => sink.configs(),
        enable: (id) => sink.enable(id),
        add: (repository) => sink.addRepo(repository),
      });
      enabled.push(...outcome.enabled);
      added.push(...outcome.added);
    } catch (cause) {
      notes.push(`${repo}: ${(cause as Error).message}`);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    installed: scan.installed ?? [],
    filesRead,
    sources: [...sources],
    enabled: dedupe(enabled),
    added: dedupe(added),
    notes: dedupe(notes),
    found: filesRead > 0 || added.length > 0 || enabled.length > 0,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** One line for the UI: what the scan did, or why it could not. */
export function summariseDiscovery(discovery: MorpheDiscovery): string {
  const morphe = discovery.installed.map((entry) => `${entry.package}${entry.version ? ` ${entry.version}` : ''}`);
  if (!discovery.installed.length) return 'Morphe Manager is not installed on this device.';
  if (discovery.added.length || discovery.enabled.length) {
    const parts: string[] = [];
    if (discovery.added.length) parts.push(`added ${discovery.added.length}`);
    if (discovery.enabled.length) parts.push(`switched on ${discovery.enabled.length}`);
    return `Read ${discovery.filesRead} file${discovery.filesRead === 1 ? '' : 's'} from ${morphe.join(', ')} — ${parts.join(', ')}.`;
  }
  if (discovery.filesRead > 0) {
    return `Read ${discovery.filesRead} file${discovery.filesRead === 1 ? '' : 's'}, but none of them named a patch source.`;
  }
  return `${morphe.join(', ')} is installed, but Android keeps its sources private — paste them once instead.`;
}
