import type { BundleSourceRef } from './bundleSource.ts';
import { parseBundleSources } from './bundleSource.ts';

/**
 * Applies a pasted "these are my Morphe sources" list to whichever bundle store
 * the current build has.
 *
 * The rule the app is built around: PatchPilot only offers what Morphe has
 * loaded. So importing never adds a bundle the user did not name, and matching
 * an existing bundle turns it back on instead of creating a duplicate.
 */

export interface ImportableBundle {
  id: string;
  name: string;
  repo?: string;
  enabled: boolean;
}

export interface BundleImportAdapter {
  configs(): ImportableBundle[];
  enable(id: string): Promise<void>;
  add(repo: string): Promise<void>;
}

export interface BundleImportOutcome {
  /** Bundles that were already known and got switched on. */
  enabled: string[];
  /** Bundles that had to be fetched before they could be used. */
  added: string[];
  skipped: { source: string; reason: string }[];
}

function sameRepo(config: ImportableBundle, repo: string): boolean {
  return (config.repo ?? '').toLowerCase() === repo.toLowerCase();
}

export async function importBundleSources(text: string, adapter: BundleImportAdapter): Promise<BundleImportOutcome> {
  const parsed = parseBundleSources(text);
  const outcome: BundleImportOutcome = { enabled: [], added: [], skipped: [...parsed.skipped] };

  for (const entry of parsed.entries) {
    const configs = adapter.configs();
    const match = findMatch(configs, entry);

    if (match) {
      if (!match.enabled) {
        await adapter.enable(match.id);
        outcome.enabled.push(match.name);
      }
      continue;
    }

    if (entry.kind === 'name') {
      outcome.skipped.push({
        source: entry.value,
        reason: 'No bundle by that name is loaded — add its repository instead.',
      });
      continue;
    }

    await adapter.add(entry.value);
    outcome.added.push(entry.value);
  }

  return outcome;
}

function findMatch(configs: ImportableBundle[], entry: BundleSourceRef): ImportableBundle | null {
  if (entry.kind === 'github') {
    return configs.find((config) => sameRepo(config, entry.value)) ?? null;
  }
  const wanted = entry.value.toLowerCase();
  return (
    configs.find((config) => config.name.toLowerCase() === wanted) ??
    configs.find((config) => config.name.toLowerCase().includes(wanted)) ??
    null
  );
}
