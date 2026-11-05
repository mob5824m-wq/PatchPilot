import { defaultSettings } from '../shared/defaults.ts';
import type {
  ApkFileType,
  CatalogResponse,
  DoctorCheck,
  DownloadJob,
  MorpheScanResponse,
  HealthResponse,
  ResolveCandidate,
  Settings,
} from '../shared/types.ts';
import { verifyApk, type ExpectedApp } from '../shared/verifyMeta.ts';
import { bundleChecks, libraryChecks, morpheCheck, providerChecks, report, settingsChecks } from '../shared/doctor.ts';
import { importBundleSources } from '../shared/bundleImport.ts';
import { discoverMorphe, summariseDiscovery } from './morpheScan.ts';
import { buildAppDetail, buildCatalog } from '../server/catalog.ts';
import { request } from '../server/http.ts';
import type { Provider } from '../server/providers/types.ts';
import { buildUserAgent, PROJECT_URL } from '../shared/userAgent.ts';
import type { LocalBundles } from './bundles.ts';
import type { LocalJobs } from './jobs.ts';
import { toApkFileInfo, type LocalLibrary } from './library.ts';
import type { Native } from './native.ts';
import { activeAppProviders, providerStatus } from './providers.ts';

/**
 * The HTTP API the web UI already speaks, implemented without a server.
 *
 * `install.ts` intercepts `/api/*` fetches and hands them here, so the entire
 * React app — catalog, jobs, library, sources, bundles — runs unchanged inside
 * the Android WebView while the work happens on the device.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface LocalBackendOptions {
  native: Native;
  bundles: LocalBundles;
  library: LocalLibrary;
  /** Resolved lazily: the job runner needs the backend's live settings. */
  getJobs: () => LocalJobs;
  settings: Settings;
  version: string;
  saveSettings: (settings: Settings) => Promise<void>;
}

const SETTINGS_KEY = 'settings.v1';

export function defaultAppSettings(): Settings {
  return { ...defaultSettings, providers: {} };
}

export async function loadAppSettings(native: Native): Promise<Settings> {
  try {
    const raw = await native.getStore(SETTINGS_KEY);
    if (!raw) return defaultAppSettings();
    const stored = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...stored, providers: { ...(stored.providers ?? {}) } };
  } catch {
    return defaultAppSettings();
  }
}

function bytesOf(body: unknown): Uint8Array | null {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

function textOf(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (body && typeof body === 'object' && !(body instanceof Uint8Array)) return body as Record<string, unknown>;
  return {};
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  const direct = bytesOf(body);
  if (direct) return direct;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new ApiError('No file received');
}

export class LocalBackend {
  private catalogCache: CatalogResponse | null = null;
  private settings: Settings;
  constructor(private readonly options: LocalBackendOptions) {
    this.settings = options.settings;
  }

  private get jobs(): LocalJobs {
    return this.options.getJobs();
  }

  /** Live settings, for the job runner. */
  currentSettings(): Settings {
    return this.settings;
  }

  /* ------------------------------------------------------------- plumbing --- */

  private catalog(): CatalogResponse {
    if (!this.catalogCache) {
      const built = buildCatalog(this.options.bundles.payloads());
      this.catalogCache = {
        ...built,
        morphe: { loaded: built.bundles.length, available: this.options.bundles.infos().length },
      };
    }
    return this.catalogCache;
  }

  private invalidate(): void {
    this.catalogCache = null;
  }

  private json(body: unknown, status = 200): ApiResult {
    return { status, body };
  }

  /* ---------------------------------------------------------------- routes --- */

  async handle(method: string, path: string, query: URLSearchParams, body: unknown): Promise<ApiResult> {
    const route = `${method.toUpperCase()} ${path}`;
    try {
      return await this.route(route, path, query, body);
    } catch (error) {
      if (error instanceof ApiError) return this.json({ error: error.message }, error.status);
      return this.json({ error: (error as Error).message }, 500);
    }
  }

  private async route(
    route: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Promise<ApiResult> {
    const parts = path.split('/').filter(Boolean); // ['api', ...]

    if (route === 'GET /api/health') {
      const health: HealthResponse = {
        ok: true,
        version: this.options.version,
        commit: null,
        demoSource: false,
        dataDir: 'Downloads/PatchPilot',
        libraryDir: 'Downloads/PatchPilot',
        node: `Android SDK ${this.options.native.device.sdk}`,
        platform: this.options.native.device.model,
        warnings: [
          'Standalone mode: the catalog, the mirrors and the verification all run on this phone.',
        ],
      };
      return this.json(health);
    }

    if (route === 'GET /api/catalog') {
      if (query.get('refresh') === '1') {
        await this.options.bundles.refreshAll();
        this.invalidate();
      }
      return this.json(this.catalog());
    }

    if (route.startsWith('GET /api/apps/')) {
      const detail = buildAppDetail(this.options.bundles.payloads(), decodeURIComponent(parts[2] ?? ''));
      if (!detail) throw new ApiError('Unknown package', 404);
      return this.json(detail);
    }

    if (route === 'POST /api/resolve') {
      const input = textOf(body);
      const packageName = String(input.packageName ?? '');
      if (!packageName) throw new ApiError('packageName is required');
      const app = this.catalog().apps.find((entry) => entry.packageName === packageName);
      if (!app) throw new ApiError('Unknown package', 404);
      const target = app.targets.find((entry) => entry.version === input.version) ?? app.targets[0];
      if (!target) throw new ApiError('No supported version for this app', 404);

      const candidates: ResolveCandidate[] = [];
      for (const provider of activeAppProviders(this.settings)) {
        try {
          const result = await provider.resolve({
            packageName,
            appName: app.name,
            versionName: target.version,
            versionCodes: target.versionCodes,
            fileType: app.fileType,
            preferAbi: this.settings.preferAbi,
            log: () => undefined,
          });
          for (const file of result.files) {
            candidates.push({
              providerId: provider.id,
              providerLabel: provider.label,
              kind: 'file',
              url: file.url,
              label: file.label,
              status: 'ok',
              detail: result.detail,
            });
          }
          for (const page of result.pages) {
            candidates.push({
              providerId: provider.id,
              providerLabel: provider.label,
              kind: 'page',
              url: page.url,
              label: page.label,
              status: 'ok',
              detail: result.detail,
            });
          }
          if (!result.files.length && !result.pages.length) {
            candidates.push({
              providerId: provider.id,
              providerLabel: provider.label,
              kind: 'page',
              url: provider.homepage,
              label: provider.label,
              status: 'empty',
              detail: result.detail,
            });
          }
        } catch (error) {
          candidates.push({
            providerId: provider.id,
            providerLabel: provider.label,
            kind: 'page',
            url: provider.homepage,
            label: provider.label,
            status: 'error',
            detail: (error as Error).message,
          });
        }
      }
      return this.json({ packageName, version: target.version, candidates });
    }

    /* ---------------------------------------------------------------- bundles --- */

    if (route === 'GET /api/bundles') return this.json({ bundles: this.options.bundles.infos() });

    if (route === 'POST /api/bundles') {
      const input = textOf(body);
      const repo = String(input.repo ?? '').trim();
      if (!repo) throw new ApiError('repo is required (owner/name)');
      const info = await this.options.bundles.addRepo(repo, input.name ? String(input.name) : undefined);
      this.invalidate();
      return this.json(info, 201);
    }

    if (route === 'GET /api/morphe') {
      return this.json({ supported: true, discovery: this.settings.morpheScan ?? null, notes: [] });
    }

    if (route === 'POST /api/morphe/scan') {
      const discovery = await discoverMorphe(
        {
          scan: () => this.options.native.scanMorphe(),
          read: (path) => this.options.native.readMorpheFile(path),
        },
        {
          configs: () => this.options.bundles.getConfigs(),
          enable: async (id) => {
            await this.options.bundles.setEnabled(id, true);
          },
          addRepo: async (repo) => {
            await this.options.bundles.addRepo(repo);
          },
          addArchive: async (name, bytes) => (await this.options.bundles.addUpload(name, bytes)).name,
          addPatchList: async (name, list) => (await this.options.bundles.addPatchList(name, list)).name,
        },
      );
      this.invalidate();
      this.settings = { ...this.settings, morpheScan: discovery };
      await this.options.saveSettings(this.settings);
      return this.json({
        supported: true,
        discovery,
        notes: [summariseDiscovery(discovery)],
      } satisfies MorpheScanResponse);
    }

    if (route === 'POST /api/bundles/import') {
      // The page posts JSON text, so it is decoded the same way as every other route.
      const { sources } = textOf(body);
      const outcome = await importBundleSources(String(sources ?? ''), {
        configs: () => this.options.bundles.getConfigs(),
        enable: async (id) => {
          await this.options.bundles.setEnabled(id, true);
        },
        add: async (repo) => {
          await this.options.bundles.addRepo(repo);
        },
      });
      this.invalidate();
      return this.json({ ...outcome, bundles: this.options.bundles.infos() });
    }

    if (route === 'POST /api/bundles/upload') {
      const bytes = await bodyBytes(body);
      const name = query.get('name') ?? 'uploaded-bundle.mpp';
      const info = await this.options.bundles.addUpload(name, bytes);
      this.invalidate();
      return this.json(info, 201);
    }

    if (route === 'POST /api/bundles/refresh-all') {
      const bundles = await this.options.bundles.refreshAll();
      this.invalidate();
      return this.json({ bundles });
    }

    if (route === 'POST /api/bundles/reset') {
      const bundles = await this.options.bundles.reset();
      this.invalidate();
      return this.json({ bundles });
    }

    if (parts.length === 4 && parts[1] === 'bundles' && parts[3] === 'refresh' && method(route) === 'POST') {
      const info = await this.options.bundles.refresh(decodeURIComponent(parts[2] ?? ''));
      this.invalidate();
      return this.json({ bundles: [info] });
    }

    if (parts.length === 4 && parts[1] === 'bundles' && parts[3] === 'enabled' && method(route) === 'POST') {
      const input = textOf(body);
      const bundles = await this.options.bundles.setEnabled(decodeURIComponent(parts[2] ?? ''), input.enabled !== false);
      this.invalidate();
      return this.json({ bundles });
    }

    if (parts.length === 3 && parts[1] === 'bundles' && method(route) === 'DELETE') {
      const removed = await this.options.bundles.remove(decodeURIComponent(parts[2] ?? ''));
      this.invalidate();
      return this.json({ removed });
    }

    /* -------------------------------------------------------------- providers --- */

    if (route === 'GET /api/providers') return this.json({ providers: providerStatus(this.settings) });

    if (parts.length === 4 && parts[1] === 'providers' && parts[3] === 'probe' && method(route) === 'POST') {
      return this.json(await this.probe(decodeURIComponent(parts[2] ?? '')));
    }

    if (parts.length === 4 && parts[1] === 'providers' && parts[3] === 'enabled' && method(route) === 'POST') {
      const id = decodeURIComponent(parts[2] ?? '');
      const input = textOf(body);
      const status = providerStatus(this.settings).find((entry) => entry.id === id);
      if (!status) throw new ApiError('Unknown provider', 404);
      const current = this.settings.providers[id] ?? { enabled: status.enabled, order: status.order };
      this.settings = {
        ...this.settings,
        providers: { ...this.settings.providers, [id]: { ...current, enabled: input.enabled !== false } },
      };
      await this.options.saveSettings(this.settings);
      return this.json({ providers: providerStatus(this.settings) });
    }

    if (route === 'POST /api/providers/order') {
      const input = textOf(body);
      const order = Array.isArray(input.order) ? (input.order as string[]) : [];
      const providers = { ...this.settings.providers };
      order.forEach((id, index) => {
        providers[id] = { enabled: providers[id]?.enabled ?? true, order: (index + 1) * 10 };
      });
      this.settings = { ...this.settings, providers };
      await this.options.saveSettings(this.settings);
      return this.json({ providers: providerStatus(this.settings) });
    }

    /* --------------------------------------------------------------- settings --- */

    if (route === 'GET /api/doctor') {
      const providers = activeAppProviders(this.settings);
      const device = await this.options.native.state();

      const free = device.freeBytes ?? 0;
      const gigabytes = free / 1024 / 1024 / 1024;
      const storage: DoctorCheck = {
        id: 'storage',
        label: 'Storage',
        status: gigabytes >= 2 ? 'pass' : gigabytes >= 0.5 ? 'warn' : 'fail',
        detail: `${gigabytes.toFixed(1)} GB free of ${((device.totalBytes ?? 0) / 1024 / 1024 / 1024).toFixed(0)} GB`,
        hint: gigabytes >= 2 ? null : 'A split bundle can be 200 MB; free space before downloading.',
      };

      const install: DoctorCheck = {
        id: 'install',
        label: 'Install permission',
        status: device.installAllowed ? 'pass' : 'warn',
        detail: device.installAllowed
          ? 'PatchPilot may offer downloaded APKs to the installer.'
          : 'Android has not allowed this app to install APKs yet.',
        hint: device.installAllowed ? null : 'Allow “install unknown apps” for PatchPilot when the installer asks.',
      };

      const notifications: DoctorCheck = {
        id: 'notifications',
        label: 'Download notifications',
        status: device.notifications === false ? 'warn' : 'pass',
        detail: device.notifications === false ? 'Notifications are off, so background progress is hidden.' : 'On.',
        hint: device.notifications === false ? 'Enable notifications to watch a long download.' : null,
      };

      return this.json(
        report('device', [
          storage,
          install,
          notifications,
          ...bundleChecks(this.options.bundles.infos()),
          morpheCheck(this.settings.morpheScan),
          ...libraryChecks(await this.options.library.list()),
          ...settingsChecks(this.settings, activeAppProviders(this.settings).length),
          ...(await providerChecks(providers)),
          {
            id: 'version',
            label: 'Version',
            status: 'pass',
            detail: `PatchPilot ${this.options.version} on ${this.options.native.device.model} (Android SDK ${this.options.native.device.sdk})`,
            hint: null,
          },
        ]),
      );
    }

    if (route === 'GET /api/settings') return this.json(this.settings);

    if (route === 'PUT /api/settings') {
      const input = textOf(body) as Partial<Settings>;
      this.settings = {
        ...this.settings,
        ...input,
        providers: { ...this.settings.providers, ...(input.providers ?? {}) },
      };
      await this.options.saveSettings(this.settings);
      return this.json(this.settings);
    }

    /* ------------------------------------------------------------------ jobs --- */

    if (route === 'POST /api/downloads') {
      const input = textOf(body);
      const packageName = String(input.packageName ?? '');
      if (!packageName) throw new ApiError('packageName is required');
      const app = this.catalog().apps.find((entry) => entry.packageName === packageName);
      if (!app) throw new ApiError('Unknown package', 404);
      const version = input.version ? String(input.version) : null;
      const target = version ? app.targets.find((entry) => entry.version === version) : app.targets.find((entry) => entry.version === app.recommendedVersion);
      if (version && !target) throw new ApiError(`${app.name} ${version} is not supported by the loaded patches`);

      const job = this.jobs.create({
        packageName: app.packageName,
        appName: app.name,
        version: target?.version ?? null,
        versionCodes: target?.versionCodes ?? null,
        fileType: app.fileType,
        signatures: app.signatures,
        providers: Array.isArray(input.providers) ? (input.providers as string[]) : null,
      });
      return this.json(job, 202);
    }

    if (route === 'GET /api/downloads') return this.json({ jobs: this.jobs.list() });

    if (parts.length === 3 && parts[1] === 'downloads' && method(route) === 'GET') {
      const job = this.jobs.get(decodeURIComponent(parts[2] ?? ''));
      if (!job) throw new ApiError('Unknown job', 404);
      return this.json(job);
    }

    if (parts.length === 4 && parts[1] === 'downloads' && parts[3] === 'cancel') {
      return this.json({ cancelled: this.jobs.cancel(decodeURIComponent(parts[2] ?? '')) });
    }

    if (parts.length === 4 && parts[1] === 'downloads' && parts[3] === 'events') {
      const job = this.jobs.get(decodeURIComponent(parts[2] ?? ''));
      if (!job) throw new ApiError('Unknown job', 404);
      return this.json(job);
    }

    /* --------------------------------------------------------------- library --- */

    if (route === 'GET /api/library') return this.json({ entries: await this.options.library.list() });

    if (route === 'POST /api/library/prune') {
      const removed = await this.options.library.pruneDemo();
      return this.json({ removed, entries: await this.options.library.list() });
    }

    if (route === 'POST /api/open-morphe') {
      const result = await this.options.native.openMorphe();
      const opened = Boolean(result?.package);
      return this.json({
        opened,
        package: result?.package ?? null,
        message: opened
          ? `Opened ${result?.package}`
          : 'Morphe Manager is not installed on this device',
      });
    }

    if (parts.length === 3 && parts[1] === 'library' && method(route) === 'DELETE') {
      return this.json({ removed: await this.options.library.remove(decodeURIComponent(parts[2] ?? '')) });
    }

    if (parts.length === 4 && parts[1] === 'library' && parts[3] === 'inspect') {
      const detail = await this.options.library.describe(decodeURIComponent(parts[2] ?? ''));
      if (!detail) throw new ApiError('Unknown library entry', 404);
      return this.json(detail);
    }

    if (parts.length === 4 && parts[1] === 'library' && parts[3] === 'install' && method(route) === 'POST') {
      const installed = await this.options.library.install(decodeURIComponent(parts[2] ?? ''));
      if (!installed) throw new ApiError('Unknown library entry', 404);
      return this.json({ installed });
    }

    if (parts.length === 4 && parts[1] === 'library' && parts[3] === 'file') {
      return this.json(
        {
          error:
            'Files are already saved: PatchPilot puts verified APKs straight into Downloads/PatchPilot on this device.',
        },
        409,
      );
    }

    /* ----------------------------------------------------------------- verify --- */

    if (route === 'POST /api/verify') {
      const bytes = await bodyBytes(body);
      const name = query.get('name') ?? 'upload.apk';
      const observed = await this.options.native.inspectBytes(name, bytes);
      const file = toApkFileInfo(observed, name, observed.tempPath ?? '');
      const packageName = query.get('packageName') ?? file.packageName ?? '';
      const version = query.get('version') ?? file.versionName ?? null;
      const app = this.catalog().apps.find((entry) => entry.packageName === packageName);
      const target = app?.targets.find((entry) => entry.version === version) ?? null;

      const expected: ExpectedApp = {
        packageName,
        appName: app?.name ?? file.packageName ?? packageName,
        versionName: version,
        versionCodes: target?.versionCodes ?? null,
        fileType: (app?.fileType ?? null) as ApkFileType | null,
        signatures: app?.signatures ?? [],
        preferAbi: this.settings.preferAbi,
      };
      const verification = verifyApk(file, expected);

      let libraryEntry = null;
      if (query.get('keep') === '1' && verification.status !== 'fail' && observed.tempPath) {
        libraryEntry = await this.options.library.add({
          file,
          tempPath: observed.tempPath,
          verification,
          appName: app?.name ?? null,
          providerId: 'manual',
          sourceUrl: null,
          notes: 'Added manually',
        });
      } else if (observed.tempPath) {
        await this.options.native.deleteTemp(observed.tempPath).catch(() => undefined);
      }

      return this.json({ file, verification, libraryEntry });
    }

    throw new ApiError('Unknown API route', 404);
  }

  private async probe(id: string): Promise<{ id: string; reachable: boolean; status: number | null; latencyMs: number | null; detail: string }> {
    const provider = activeAppProviders(this.settings).find((entry) => entry.id === id);
    const target = id === 'morphe-api'
      ? 'https://api.morphe.software/v2/web-search/com.google.android.youtube~21.43.523~arm64-v8a'
      : (provider as Provider | undefined)?.homepage ?? PROJECT_URL;

    const started = Date.now();
    try {
      const response = await request(target, { method: 'GET', redirect: 'manual', timeoutMs: 10_000 });
      await response.body?.cancel().catch(() => undefined);
      return {
        id,
        reachable: response.status < 500,
        status: response.status,
        latencyMs: Date.now() - started,
        detail:
          response.status === 403
            ? 'Reachable, but refusing automated requests (Cloudflare or geo-block).'
            : `Answered HTTP ${response.status} in ${Date.now() - started} ms.`,
      };
    } catch (error) {
      return { id, reachable: false, status: null, latencyMs: Date.now() - started, detail: (error as Error).message };
    }
  }

  /* ------------------------------------------------------------------- jobs --- */

  userAgent(): string {
    return buildUserAgent(this.options.version);
  }
}

function method(route: string): string {
  return route.split(' ')[0] ?? 'GET';
}
