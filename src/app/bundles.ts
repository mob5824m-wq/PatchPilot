import { cloneDefaultBundles } from '../shared/defaults.ts';
import type { BundleConfig, BundleInfo } from '../shared/types.ts';
import type { BundlePayload } from '../server/catalog.ts';
import { parseBundleInfo, parsePatchList } from '../server/bundles/parse.ts';
import type { Patch } from '../server/bundles/types.ts';
import { request } from '../server/http.ts';
import { extractFromBundleArchive } from './mpp.ts';
import { fromBase64, type Native } from './native.ts';

/**
 * Bundle handling for the phone.
 *
 * Same parsing as the server, different storage: the fetched patch lists are
 * kept in the shell's key-value store (a file behind the scenes) and the app is
 * seeded from `fixtures/bundles` so a fresh install shows a real catalog before
 * the network has said anything.
 */

export interface SeedBundle {
  id: string;
  patchesList: unknown;
  bundleInfo?: unknown;
}

interface CacheEntry {
  patchesList: unknown;
  bundleInfo: unknown;
  fetchedAt: string;
  origin: 'network' | 'seed' | 'upload';
}

interface PersistedState {
  configs: BundleConfig[];
  cache: Record<string, CacheEntry>;
}

const STORE_KEY = 'bundles.v1';
const GITHUB_TOKEN_NOTE = 'GitHub rate limit reached. Try again in an hour, or wait for the cached copy.';

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function githubHeaders(): Record<string, string> {
  return { accept: 'application/vnd.github+json' };
}

/** Decodes the two shapes GitHub serves: raw text, or base64 through the API. */
async function githubDocument(url: string): Promise<unknown> {
  const response = await request(url, {
    headers: { ...githubHeaders(), accept: url.includes('api.github.com') ? 'application/vnd.github+json' : '*/*' },
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) throw new Error(GITHUB_TOKEN_NOTE);
    throw new Error(`GitHub answered HTTP ${response.status}`);
  }
  if (url.includes('api.github.com')) {
    const payload = (await response.json()) as { content?: string; encoding?: string };
    if (!payload.content) throw new Error('GitHub returned no file content');
    const text = payload.encoding === 'base64' ? new TextDecoder().decode(fromBase64(payload.content.replace(/\s/g, ''))) : payload.content;
    return JSON.parse(text) as unknown;
  }
  return (await response.json()) as unknown;
}

async function firstSuccess<T>(attempts: (() => Promise<T>)[]): Promise<T> {
  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error('No source could be reached');
}

export function bundleUrls(repo: string, file: string): string[] {
  return [
    `https://raw.githubusercontent.com/${repo}/HEAD/${file}`,
    `https://api.github.com/repos/${repo}/contents/${file}`,
    `https://github.com/${repo}/raw/HEAD/${file}`,
  ];
}

export class LocalBundles {
  private configs: BundleConfig[] = [];
  private cache = new Map<string, CacheEntry>();
  private pending: Promise<void> | null = null;
  private lastRefresh: string | null = null;

  constructor(
    private readonly native: Native,
    private readonly seeds: SeedBundle[],
  ) {}

  async init(): Promise<void> {
    const stored = await this.readState();
    this.configs = stored?.configs?.length ? stored.configs : cloneDefaultBundles();
    for (const [id, entry] of Object.entries(stored?.cache ?? {})) this.cache.set(id, entry);

    // Seed anything the store does not know about yet, so the first screen has
    // a real catalog instead of an empty state.
    for (const config of this.configs) {
      if (this.cache.has(config.id)) continue;
      const seed = this.seeds.find((entry) => entry.id === config.id);
      if (!seed) continue;
      this.cache.set(config.id, {
        patchesList: seed.patchesList,
        bundleInfo: seed.bundleInfo ?? null,
        fetchedAt: new Date().toISOString(),
        origin: 'seed',
      });
    }
    await this.persist();
  }

  /** Refreshes in the background, once, without blocking the first paint. */
  refreshInBackground(): void {
    if (this.pending) return;
    this.pending = this.refreshAll()
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        this.pending = null;
      });
  }

  get lastRefreshAt(): string | null {
    return this.lastRefresh;
  }

  payloads(): BundlePayload[] {
    return this.configs
      .filter((config) => config.enabled)
      .map((config) => this.payload(config))
      .filter((payload): payload is BundlePayload => payload !== null);
  }

  infos(): BundleInfo[] {
    return this.configs.map((config) => this.info(config));
  }

  private payload(config: BundleConfig): BundlePayload | null {
    const cached = this.cache.get(config.id);
    if (!cached) return null;
    const parsed = parsePatchList(cached.patchesList, config.id);
    return { info: this.info(config), patches: parsed.patches };
  }

  private info(config: BundleConfig): BundleInfo {
    const cached = this.cache.get(config.id);
    const parsed = cached ? parsePatchList(cached.patchesList, config.id) : null;
    const meta = parseBundleInfo(cached?.bundleInfo ?? null);
    const packages = new Set<string>();
    for (const patch of parsed?.patches ?? []) {
      for (const compatibility of patch.compatibility) packages.add(compatibility.packageName);
      if (patch.legacyUniversal) packages.add('*');
    }

    return {
      id: config.id,
      name: config.name,
      kind: config.kind,
      repo: config.repo,
      enabled: config.enabled,
      builtin: config.builtin,
      version: parsed?.version ?? meta.version,
      patchCount: parsed?.patches.length ?? 0,
      packageCount: packages.size,
      fetchedAt: cached?.fetchedAt ?? null,
      origin: cached?.origin ?? null,
      stale: !cached,
      error: cached ? null : 'Not loaded yet',
      downloadUrl: meta.downloadUrl,
    };
  }

  patchListFor(id: string): Patch[] {
    return this.payloads()
      .filter((payload) => payload.info.id === id)
      .flatMap((payload) => payload.patches);
  }

  private async loadFromNetwork(config: BundleConfig): Promise<CacheEntry> {
    if (config.kind === 'upload') {
      const existing = this.cache.get(config.id);
      if (!existing) throw new Error('This bundle was uploaded — re-add the file to restore it.');
      return existing;
    }
    if (!config.repo) throw new Error('This bundle has no repository');
    const patchesList = await firstSuccess(bundleUrls(config.repo, 'patches-list.json').map((url) => () => githubDocument(url)));
    let bundleInfo: unknown = null;
    try {
      bundleInfo = await firstSuccess(
        bundleUrls(config.repo, 'patches-bundle.json').map((url) => () => githubDocument(url)),
      );
    } catch {
      // Metadata is optional; the patch list is what matters.
    }
    return { patchesList, bundleInfo, fetchedAt: new Date().toISOString(), origin: 'network' };
  }

  async refresh(id: string): Promise<BundleInfo> {
    const config = this.configs.find((entry) => entry.id === id);
    if (!config) throw new Error('Unknown bundle');
    const entry = await this.loadFromNetwork(config);
    this.cache.set(id, entry);
    this.lastRefresh = entry.fetchedAt;
    await this.persist();
    return this.info(config);
  }

  async refreshAll(): Promise<BundleInfo[]> {
    const results: BundleInfo[] = [];
    for (const config of this.configs) {
      if (!config.enabled) continue;
      try {
        results.push(await this.refresh(config.id));
      } catch {
        results.push(this.info(config));
      }
    }
    return this.infos();
  }

  async addRepo(repo: string, name?: string): Promise<BundleInfo> {
    const cleaned = repo
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) throw new Error('Use owner/name, for example MorpheApp/morphe-patches');

    const id = slug(cleaned);
    if (this.configs.some((config) => config.id === id)) throw new Error('That bundle is already loaded');

    const config: BundleConfig = {
      id,
      name: name?.trim() || cleaned.split('/')[1] || cleaned,
      kind: 'github',
      repo: cleaned,
      enabled: true,
      builtin: false,
    };
    this.configs.push(config);
    const entry = await this.loadFromNetwork(config);
    this.cache.set(id, entry);
    await this.persist();
    return this.info(config);
  }

  async addUpload(name: string, bytes: Uint8Array): Promise<BundleInfo> {
    const { patchesList, bundleInfo } = await extractFromBundleArchive(bytes);
    const id = `upload-${slug(name.replace(/\.mpp$/i, '')) || 'bundle'}`;
    const existing = this.configs.find((config) => config.id === id);
    const config: BundleConfig = existing ?? {
      id,
      name: name.replace(/\.mpp$/i, ''),
      kind: 'upload',
      enabled: true,
      builtin: false,
    };
    if (!existing) this.configs.push(config);
    this.cache.set(id, { patchesList, bundleInfo, fetchedAt: new Date().toISOString(), origin: 'upload' });
    await this.persist();
    return this.info(config);
  }

  /**
   * A bare `patches-list.json` — what a bundle is when it is not zipped. Morphe
   * accepts one, and so should a file picked off the device.
   */
  async addPatchList(name: string, patchesList: unknown, bundleInfo: unknown = null): Promise<BundleInfo> {
    const label = name.replace(/\.(json|mpp)$/i, '');
    const id = `list-${slug(label) || 'bundle'}`;
    const existing = this.configs.find((config) => config.id === id);
    const config: BundleConfig = existing ?? {
      id,
      name: label,
      kind: 'upload',
      enabled: true,
      builtin: false,
    };
    if (!existing) this.configs.push(config);
    this.cache.set(id, { patchesList, bundleInfo, fetchedAt: new Date().toISOString(), origin: 'upload' });
    await this.persist();
    return this.info(config);
  }

  /** The raw list, for logic that has to reason about what is and is not loaded. */
  getConfigs(): BundleConfig[] {
    return [...this.configs];
  }

  async setEnabled(id: string, enabled: boolean): Promise<BundleInfo[]> {
    const config = this.configs.find((entry) => entry.id === id);
    if (!config) throw new Error('Unknown bundle');
    config.enabled = enabled;
    await this.persist();
    return this.infos();
  }

  async remove(id: string): Promise<boolean> {
    const config = this.configs.find((entry) => entry.id === id);
    if (!config) return false;
    if (config.builtin) throw new Error('Bundled sources can be disabled but not removed');
    this.configs = this.configs.filter((entry) => entry.id !== id);
    this.cache.delete(id);
    await this.persist();
    return true;
  }

  async reset(): Promise<BundleInfo[]> {
    this.configs = cloneDefaultBundles();
    this.cache.clear();
    for (const config of this.configs) {
      const seed = this.seeds.find((entry) => entry.id === config.id);
      if (!seed) continue;
      this.cache.set(config.id, {
        patchesList: seed.patchesList,
        bundleInfo: seed.bundleInfo ?? null,
        fetchedAt: new Date().toISOString(),
        origin: 'seed',
      });
    }
    await this.persist();
    return this.infos();
  }

  private async readState(): Promise<PersistedState | null> {
    try {
      const raw = await this.native.getStore(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as PersistedState;
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { configs: this.configs, cache: Object.fromEntries(this.cache) };
    try {
      await this.native.setStore(STORE_KEY, JSON.stringify(state));
    } catch {
      // Persistence is a convenience; a full disk must not break the session.
    }
  }
}
