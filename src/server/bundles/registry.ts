import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleConfig, BundleInfo } from '../../shared/types.ts';
import { ZipReader } from '../apk/zip.ts';
import type { BundlePayload } from '../catalog.ts';
import {
  bundleCacheDir,
  cloneDefaultBundles,
  defaultBundles,
  fixtureDir,
  loadBundleConfigs,
  offlineMode,
  saveBundleConfigs,
  uploadDir,
} from '../config.ts';
import { fetchJson, HttpError, request } from '../http.ts';
import { readJson, writeJson } from '../store.ts';
import { parseBundleInfo, parsePatchList } from './parse.ts';
import type { Patch } from './types.ts';

/**
 * Loads patch bundles and keeps what they say about required app versions.
 *
 * A bundle is fetched from a GitHub repository (the layout every Morphe patch
 * repo uses), from a URL, or from an uploaded `.mpp`. Successful fetches are
 * cached on disk so the catalog keeps working offline, and this repository ships
 * a snapshot of three popular bundles so a fresh install has something to show.
 */

interface CachedBundle {
  fetchedAt: string;
  listUrl: string;
  patchesList: unknown;
  bundleInfo: unknown;
}

interface LoadedBundle {
  config: BundleConfig;
  info: BundleInfo;
  patches: Patch[];
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/vnd.github.raw' };
  if (GITHUB_TOKEN) headers.authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

function cachePath(id: string): string {
  return join(bundleCacheDir, `${id}.json`);
}

function seedPath(id: string, suffix: string): string {
  return join(fixtureDir, 'bundles', `${id}.${suffix}`);
}

/** Candidate URLs for the patch list, most reliable first. */
function listUrls(config: BundleConfig): string[] {
  if (config.kind === 'github' && config.repo) {
    return [
      `https://raw.githubusercontent.com/${config.repo}/HEAD/patches-list.json`,
      `https://api.github.com/repos/${config.repo}/contents/patches-list.json`,
      `https://github.com/${config.repo}/raw/HEAD/patches-list.json`,
    ];
  }
  if (config.url) {
    return [config.url];
  }
  return [];
}

function infoUrls(config: BundleConfig): string[] {
  if (config.kind === 'github' && config.repo) {
    return [
      `https://raw.githubusercontent.com/${config.repo}/HEAD/patches-bundle.json`,
      `https://api.github.com/repos/${config.repo}/contents/patches-bundle.json`,
    ];
  }
  if (config.url && config.url.includes('patches-list.json')) {
    return [config.url.replace('patches-list.json', 'patches-bundle.json')];
  }
  return [];
}

/**
 * Tries the candidate URLs in parallel and keeps the first usable answer: the
 * GitHub API route works on networks where raw.githubusercontent.com is blocked
 * (and vice versa), and racing them keeps the catalog load fast either way.
 */
async function tryFetchJson(urls: string[], timeoutMs = 15_000): Promise<{ json: unknown; url: string } | null> {
  if (!urls.length) return null;
  const attempts = urls.map(async (url) => {
    const isApi = url.includes('api.github.com');
    const json = await fetchJson(url, { timeoutMs, headers: isApi ? githubHeaders() : {} });
    if (!json || typeof json !== 'object') throw new Error(`Unexpected payload from ${url}`);
    return { json, url };
  });

  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

async function fetchLatestRelease(repo: string): Promise<string | null> {
  try {
    const response = await request(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
      timeoutMs: 12_000,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { assets?: { name?: string; browser_download_url?: string }[] };
    const asset = json.assets?.find((entry) => entry.name?.endsWith('.mpp'));
    return asset?.browser_download_url ?? null;
  } catch {
    return null;
  }
}

export class BundleRegistry {
  private readonly bundles = new Map<string, LoadedBundle>();
  private configs: BundleConfig[] = [];
  private lastRefresh: Date | null = null;

  async init(): Promise<void> {
    this.configs = await loadBundleConfigs();
    await Promise.all(this.configs.map((config) => this.load(config)));
    this.lastRefresh = new Date();
  }

  getPayloads(): BundlePayload[] {
    return [...this.bundles.values()]
      .filter((bundle) => bundle.config.enabled)
      .map((bundle) => ({ info: bundle.info, patches: bundle.patches }));
  }

  getInfos(): BundleInfo[] {
    return this.configs.map((config) => this.bundles.get(config.id)?.info ?? this.placeholderInfo(config));
  }

  getConfigs(): BundleConfig[] {
    return [...this.configs];
  }

  getRefreshTime(): Date | null {
    return this.lastRefresh;
  }

  private placeholderInfo(config: BundleConfig): BundleInfo {
    return {
      id: config.id,
      name: config.name,
      kind: config.kind,
      repo: config.repo,
      enabled: config.enabled,
      builtin: config.builtin,
      version: null,
      patchCount: 0,
      packageCount: 0,
      fetchedAt: null,
      origin: null,
      stale: true,
      error: 'Not loaded yet',
      downloadUrl: null,
    };
  }

  private async load(config: BundleConfig): Promise<void> {
    const info = this.placeholderInfo(config);
    info.error = null;

    // 1. Cached copy from a previous successful fetch.
    const cached = await readJson<CachedBundle | null>(cachePath(config.id), null);
    if (cached) {
      const parsed = parsePatchList(cached.patchesList, config.id);
      const meta = parseBundleInfo(cached.bundleInfo);
      this.bundles.set(config.id, {
        config,
        info: {
          ...info,
          version: meta.version ?? parsed.version,
          patchCount: parsed.patches.length,
          packageCount: new Set(
            parsed.patches.flatMap((patch) => patch.compatibility.map((entry) => entry.packageName)),
          ).size,
          fetchedAt: cached.fetchedAt,
          origin: 'cache',
          stale: Date.now() - Date.parse(cached.fetchedAt) > 6 * 60 * 60 * 1000,
          downloadUrl: meta.downloadUrl,
        },
        patches: parsed.patches,
      });
      return;
    }

    // 2. Network.
    if (config.kind === 'upload') {
      await this.loadUploaded(config, info);
      return;
    }

    const fetched = offlineMode ? null : await this.fetchRemote(config);
    if (fetched) {
      this.bundles.set(config.id, { config, info: fetched.info, patches: fetched.patches });
      return;
    }

    // 3. Snapshot shipped with PatchPilot.
    const seed = await this.readSeed(config);
    if (seed) {
      this.bundles.set(config.id, {
        config,
        info: {
          ...info,
          version: seed.info.version,
          patchCount: seed.patches.length,
          packageCount: new Set(
            seed.patches.flatMap((patch) => patch.compatibility.map((entry) => entry.packageName)),
          ).size,
          fetchedAt: null,
          origin: 'seed',
          stale: true,
          downloadUrl: seed.info.downloadUrl,
        },
        patches: seed.patches,
      });
      return;
    }

    this.bundles.set(config.id, {
      config,
      info: { ...info, error: 'Could not load this bundle: no network, no cache and no bundled snapshot' },
      patches: [],
    });
  }

  private async loadUploaded(config: BundleConfig, info: BundleInfo): Promise<void> {
    const path = config.url?.startsWith('file:') ? config.url.slice('file:'.length) : config.url;
    if (!path) {
      this.bundles.set(config.id, { config, info: { ...info, error: 'Uploaded bundle is missing its file' }, patches: [] });
      return;
    }
    try {
      const json = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const parsed = parsePatchList(json, config.id);
      const metaPath = path.replace(/\.patches-list\.json$/, '.patches-bundle.json');
      const meta = existsSync(metaPath)
        ? parseBundleInfo(JSON.parse(await readFile(metaPath, 'utf8')) as unknown)
        : { version: parsed.version, downloadUrl: null };
      this.bundles.set(config.id, {
        config,
        info: {
          ...info,
          version: meta.version ?? parsed.version,
          patchCount: parsed.patches.length,
          packageCount: new Set(
            parsed.patches.flatMap((patch) => patch.compatibility.map((entry) => entry.packageName)),
          ).size,
          fetchedAt: new Date().toISOString(),
          origin: 'upload',
          stale: false,
        },
        patches: parsed.patches,
      });
    } catch (error) {
      this.bundles.set(config.id, {
        config,
        info: { ...info, error: `Could not read the uploaded bundle: ${(error as Error).message}` },
        patches: [],
      });
    }
  }

  private async fetchRemote(
    config: BundleConfig,
  ): Promise<{ info: BundleInfo; patches: Patch[] } | null> {
    const list = await tryFetchJson(listUrls(config));
    if (!list) return null;
    const parsed = parsePatchList(list.json, config.id);
    if (!parsed.patches.length) return null;

    const metaResult = await tryFetchJson(infoUrls(config), 12_000);
    const meta = metaResult ? parseBundleInfo(metaResult.json) : { version: null, downloadUrl: null };

    const fetchedAt = new Date().toISOString();
    const downloadUrl =
      (meta.downloadUrl ?? null) || (config.repo ? await fetchLatestRelease(config.repo) : null);

    const info: BundleInfo = {
      id: config.id,
      name: config.name,
      kind: config.kind,
      repo: config.repo,
      enabled: config.enabled,
      builtin: config.builtin,
      version: meta.version ?? parsed.version,
      patchCount: parsed.patches.length,
      packageCount: new Set(
        parsed.patches.flatMap((patch) => patch.compatibility.map((entry) => entry.packageName)),
      ).size,
      fetchedAt,
      origin: 'network',
      stale: false,
      error: parsed.warnings.length ? `${parsed.warnings.length} entry(s) skipped while parsing` : null,
      downloadUrl,
    };

    await writeJson(cachePath(config.id), {
      fetchedAt,
      listUrl: list.url,
      patchesList: list.json,
      bundleInfo: metaResult?.json ?? null,
    } satisfies CachedBundle);

    return { info, patches: parsed.patches };
  }

  private async readSeed(
    config: BundleConfig,
  ): Promise<{ patches: Patch[]; info: { version: string | null; downloadUrl: string | null } } | null> {
    const listPath = seedPath(config.id, 'patches-list.json');
    if (!existsSync(listPath)) return null;
    try {
      const json = JSON.parse(await readFile(listPath, 'utf8')) as unknown;
      const parsed = parsePatchList(json, config.id);
      const metaPath = seedPath(config.id, 'patches-bundle.json');
      const meta = existsSync(metaPath)
        ? parseBundleInfo(JSON.parse(await readFile(metaPath, 'utf8')) as unknown)
        : { version: parsed.version, downloadUrl: null };
      return { patches: parsed.patches, info: meta };
    } catch {
      return null;
    }
  }

  /** Re-fetches one bundle (or all of them) from the network. */
  async refresh(id?: string): Promise<void> {
    const targets = id ? this.configs.filter((config) => config.id === id) : this.configs;
    for (const config of targets) {
      const current = this.bundles.get(config.id);
      const info = current?.info ?? this.placeholderInfo(config);
      if (config.kind === 'upload' || offlineMode) continue;
      const fetched = await this.fetchRemote(config);
      if (fetched) {
        this.bundles.set(config.id, { config, info: fetched.info, patches: fetched.patches });
      } else if (current) {
        this.bundles.set(config.id, {
          ...current,
          info: {
            ...info,
            error: info.origin === 'seed' || info.origin === 'cache'
              ? `Could not refresh from the network — showing ${info.origin === 'seed' ? 'the bundled snapshot' : 'the cached copy'}.`
              : 'Could not fetch this bundle.',
          },
        });
      }
    }
    this.lastRefresh = new Date();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const config = this.configs.find((entry) => entry.id === id);
    if (!config) return;
    config.enabled = enabled;
    const bundle = this.bundles.get(id);
    if (bundle) bundle.info = { ...bundle.info, enabled };
    await saveBundleConfigs(this.configs);
  }

  async addGithubBundle(repo: string, name?: string): Promise<BundleInfo> {
    const cleaned = repo
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) {
      throw new Error('Expected a repository in the form owner/name');
    }
    const id = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (this.bundles.has(id)) throw new Error('That bundle is already added');

    const config: BundleConfig = {
      id,
      name: name?.trim() || cleaned,
      kind: 'github',
      repo: cleaned,
      enabled: true,
      builtin: false,
    };

    const fetched = offlineMode ? null : await this.fetchRemote(config);
    if (!fetched) {
      throw new Error(
        `Could not fetch a patches-list.json from ${cleaned}. Patch bundles must publish patches-list.json at the repository root.`,
      );
    }

    this.configs.push(config);
    this.bundles.set(id, { config, info: fetched.info, patches: fetched.patches });
    await saveBundleConfigs(this.configs);
    return fetched.info;
  }

  async addUploadedBundle(fileName: string, bytes: Buffer): Promise<BundleInfo> {
    const id = `upload-${Date.now().toString(36)}`;
    const name = fileName.replace(/\.(mpp|json|zip)$/i, '');

    let listJson: unknown;
    let metaJson: unknown = null;

    if (/\.json$/i.test(fileName)) {
      listJson = JSON.parse(bytes.toString('utf8')) as unknown;
    } else {
      const extracted = await extractFromBundleArchive(bytes);
      listJson = extracted.patchesList;
      metaJson = extracted.bundleInfo;
    }

    const parsed = parsePatchList(listJson, id);
    if (!parsed.patches.length) throw new Error('No patches found inside that file');

    const listPath = join(uploadDir, `${id}.patches-list.json`);
    await writeFile(listPath, JSON.stringify(listJson, null, 2), 'utf8');
    if (metaJson) {
      await writeFile(join(uploadDir, `${id}.patches-bundle.json`), JSON.stringify(metaJson, null, 2), 'utf8');
    }

    const meta = metaJson ? parseBundleInfo(metaJson) : { version: parsed.version, downloadUrl: null };
    const config: BundleConfig = {
      id,
      name,
      kind: 'upload',
      url: `file:${listPath}`,
      enabled: true,
      builtin: false,
    };

    const info: BundleInfo = {
      id,
      name,
      kind: 'upload',
      enabled: true,
      builtin: false,
      version: meta.version ?? parsed.version,
      patchCount: parsed.patches.length,
      packageCount: new Set(parsed.patches.flatMap((patch) => patch.compatibility.map((entry) => entry.packageName))).size,
      fetchedAt: new Date().toISOString(),
      origin: 'upload',
      stale: false,
      error: null,
      downloadUrl: null,
    };

    this.configs.push(config);
    this.bundles.set(id, { config, info, patches: parsed.patches });
    await saveBundleConfigs(this.configs);
    return info;
  }

  async remove(id: string): Promise<boolean> {
    const config = this.configs.find((entry) => entry.id === id);
    if (!config) return false;
    if (config.builtin) throw new Error('Bundled sources cannot be removed — disable it instead');
    this.configs = this.configs.filter((entry) => entry.id !== id);
    this.bundles.delete(id);
    await saveBundleConfigs(this.configs);
    return true;
  }

  async resetToDefaults(): Promise<void> {
    this.configs = cloneDefaultBundles();
    await saveBundleConfigs(this.configs);
    await Promise.all(this.configs.map((config) => this.load(config)));
  }
}

/** Pulls `patches-list.json` (and the bundle metadata) out of a `.mpp` archive. */
export async function extractFromBundleArchive(
  bytes: Buffer,
): Promise<{ patchesList: unknown; bundleInfo: unknown }> {
  const { mkdtemp, writeFile: write, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  const dir = await mkdtemp(joinPath(tmpdir(), 'patchpilot-mpp-'));
  const path = joinPath(dir, 'bundle.mpp');
  try {
    await write(path, bytes);
    const reader = await ZipReader.open(path);
    try {
      const jsonEntries = reader.select(
        (entry) => entry.name.toLowerCase().endsWith('.json') && entry.size < 32 * 1024 * 1024,
      );
      const preferred = jsonEntries.filter((entry) => /patches-list\.json$/i.test(entry.name));
      const ordered = [...preferred, ...jsonEntries.filter((entry) => !preferred.includes(entry))];

      let patchesList: unknown = null;
      let bundleInfo: unknown = null;

      for (const entry of ordered) {
        let json: unknown;
        try {
          json = JSON.parse(await reader.readText(entry)) as unknown;
        } catch {
          continue;
        }
        if (!bundleInfo && json && typeof json === 'object' && 'version' in (json as object) && 'public_key' in (json as object)) {
          bundleInfo = json;
        }
        if (!patchesList && json && typeof json === 'object' && Array.isArray((json as { patches?: unknown }).patches)) {
          patchesList = json;
        }
        if (patchesList && bundleInfo) break;
      }

      if (!patchesList) {
        throw new Error('That archive does not contain a patches-list.json — is it a Morphe patch bundle?');
      }
      return { patchesList, bundleInfo };
    } finally {
      await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function describeHttpError(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return (error as Error).message;
}
