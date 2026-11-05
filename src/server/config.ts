import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundleConfig, Settings } from '../shared/types.ts';
import { defaultBundles, defaultSettings } from '../shared/defaults.ts';
import { buildUserAgent } from '../shared/userAgent.ts';
import { setUserAgent } from './http.ts';
import { readJson, writeJson } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');

/**
 * The version comes from the release tag, not from a hand-edited constant.
 * CI exports PATCHPILOT_VERSION from the tag it is publishing; a plain checkout
 * falls back to package.json, which the release workflow keeps in step.
 */
function packageVersion(): string {
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = process.env.PATCHPILOT_VERSION?.trim() || packageVersion();
/** Short commit SHA of the build, when CI knows it. */
export const BUILD_COMMIT = process.env.PATCHPILOT_COMMIT?.trim() || null;

export const dataDir = resolve(process.env.PATCHPILOT_DATA_DIR ?? join(repoRoot, 'data'));
export const libraryDir = join(dataDir, 'library');
export const cacheDir = join(dataDir, 'cache');
export const bundleCacheDir = join(cacheDir, 'bundles');
export const uploadDir = join(dataDir, 'uploads');
export const fixtureDir = join(repoRoot, 'fixtures');

export const port = Number(process.env.PORT ?? 3000);
export const host = process.env.HOST ?? '0.0.0.0';
export const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

/** Skips every network call and uses cached or bundled patch data only. */
export const offlineMode = process.env.PATCHPILOT_OFFLINE === '1' || process.env.PATCHPILOT_OFFLINE === 'true';

/** Enables the offline fixture provider used by tests and previews. */
export const demoSourceEnabled = process.env.PATCHPILOT_DEMO === '1' || process.env.PATCHPILOT_DEMO === 'true';

export const USER_AGENT = buildUserAgent(APP_VERSION);
setUserAgent(USER_AGENT);

export function ensureDirs(): void {
  for (const dir of [dataDir, libraryDir, cacheDir, bundleCacheDir, uploadDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export { defaultBundles, defaultSettings };

/** The demo source is on only where the environment asks for it. */
const settingsDefaults: Settings = { ...defaultSettings, demoSource: demoSourceEnabled };

const settingsPath = join(dataDir, 'settings.json');
const bundlesPath = join(dataDir, 'bundles.json');

export async function loadSettings(): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsPath, {});
  return { ...settingsDefaults, ...stored, providers: { ...stored.providers } };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(settingsPath, settings);
}

export async function loadBundleConfigs(): Promise<BundleConfig[]> {
  const stored = await readJson<BundleConfig[] | null>(bundlesPath, null);
  if (!stored) {
    await writeJson(bundlesPath, defaultBundles);
    return [...defaultBundles];
  }
  const byId = new Map(stored.map((bundle) => [bundle.id, bundle]));
  // Keep bundled defaults available even if the config file predates them.
  for (const fallback of defaultBundles) {
    if (!byId.has(fallback.id)) byId.set(fallback.id, fallback);
  }
  return [...byId.values()];
}

export async function saveBundleConfigs(bundles: BundleConfig[]): Promise<void> {
  await writeJson(bundlesPath, bundles);
}

export const paths = {
  settings: settingsPath,
  bundles: bundlesPath,
  libraryIndex: join(dataDir, 'library.json'),
  jobs: join(dataDir, 'jobs.json'),
};
