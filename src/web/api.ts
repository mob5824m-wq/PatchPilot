import type {
  AppDetail,
  BundleImportResult,
  DoctorReport,
  MorpheScanResponse,
  BundleInfo,
  CatalogResponse,
  DownloadJob,
  HealthResponse,
  LibraryEntry,
  ProviderInfo,
  ResolveCandidate,
  Settings,
  VerificationResult,
  ApkFileInfo,
} from '../shared/types.ts';

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

const jsonHeaders = { 'content-type': 'application/json' };

export const api = {
  health: () => fetch('/api/health').then((response) => parse<HealthResponse>(response)),

  doctor: () => fetch('/api/doctor').then((response) => parse<DoctorReport>(response)),

  catalog: (refresh = false) =>
    fetch(`/api/catalog${refresh ? '?refresh=1' : ''}`).then((response) => parse<CatalogResponse>(response)),

  app: (packageName: string) =>
    fetch(`/api/apps/${encodeURIComponent(packageName)}`).then((response) => parse<AppDetail>(response)),

  resolve: (packageName: string, version: string | null) =>
    fetch('/api/resolve', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ packageName, version }),
    }).then((response) => parse<{ packageName: string; version: string; candidates: ResolveCandidate[] }>(response)),

  bundles: () =>
    fetch('/api/bundles').then((response) => parse<{ bundles: BundleInfo[] }>(response)),

  morphe: () => fetch('/api/morphe').then((response) => parse<MorpheScanResponse>(response)),

  scanMorphe: () => fetch('/api/morphe/scan', { method: 'POST' }).then((response) => parse<MorpheScanResponse>(response)),

  pickMorpheFolder: () =>
    fetch('/api/morphe/folder', { method: 'POST' }).then((response) => parse<MorpheScanResponse>(response)),

  importBundles: (sources: string) =>
    fetch('/api/bundles/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources }),
    }).then((response) => parse<BundleImportResult>(response)),

  addBundle: (repo: string, name?: string) =>
    fetch('/api/bundles', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ repo, name }),
    }).then((response) => parse<BundleInfo>(response)),

  uploadBundle: (file: File) =>
    fetch(`/api/bundles/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }).then((response) => parse<BundleInfo>(response)),

  refreshAllBundles: () =>
    fetch('/api/bundles/refresh-all', { method: 'POST' }).then((response) => parse<{ bundles: BundleInfo[] }>(response)),

  refreshBundle: (id: string) =>
    fetch(`/api/bundles/${encodeURIComponent(id)}/refresh`, { method: 'POST' }).then((response) =>
      parse<{ bundles: BundleInfo[] }>(response),
    ),

  toggleBundle: (id: string, enabled: boolean) =>
    fetch(`/api/bundles/${encodeURIComponent(id)}/enabled`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ enabled }),
    }).then((response) => parse<{ bundles: BundleInfo[] }>(response)),

  removeBundle: (id: string) =>
    fetch(`/api/bundles/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((response) =>
      parse<{ removed: boolean }>(response),
    ),

  resetBundles: () =>
    fetch('/api/bundles/reset', { method: 'POST' }).then((response) => parse<{ bundles: BundleInfo[] }>(response)),

  providers: () =>
    fetch('/api/providers').then((response) => parse<{ providers: ProviderInfo[] }>(response)),

  probeProvider: (id: string) =>
    fetch(`/api/providers/${encodeURIComponent(id)}/probe`, { method: 'POST' }).then((response) =>
      parse<{ id: string; reachable: boolean; status: number | null; latencyMs: number | null; detail: string }>(response),
    ),

  toggleProvider: (id: string, enabled: boolean) =>
    fetch(`/api/providers/${encodeURIComponent(id)}/enabled`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ enabled }),
    }).then((response) => parse<{ providers: ProviderInfo[] }>(response)),

  orderProviders: (order: string[]) =>
    fetch('/api/providers/order', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ order }),
    }).then((response) => parse<{ providers: ProviderInfo[] }>(response)),

  settings: () => fetch('/api/settings').then((response) => parse<Settings>(response)),

  saveSettings: (settings: Partial<Settings>) =>
    fetch('/api/settings', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(settings) }).then((response) =>
      parse<Settings>(response),
    ),

  startDownload: (packageName: string, version: string | null, providers?: string[]) =>
    fetch('/api/downloads', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ packageName, version, providers }),
    }).then((response) => parse<DownloadJob>(response)),

  jobs: () => fetch('/api/downloads').then((response) => parse<{ jobs: DownloadJob[] }>(response)),

  job: (id: string) => fetch(`/api/downloads/${id}`).then((response) => parse<DownloadJob>(response)),

  cancelJob: (id: string) =>
    fetch(`/api/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((response) =>
      parse<{ cancelled: boolean }>(response),
    ),

  library: () => fetch('/api/library').then((response) => parse<{ entries: LibraryEntry[] }>(response)),

  pruneLibrary: () =>
    fetch('/api/library/prune', { method: 'POST' }).then((response) =>
      parse<{ removed: number; entries: LibraryEntry[] }>(response),
    ),

  openMorphe: () =>
    fetch('/api/open-morphe', { method: 'POST' }).then((response) =>
      parse<{ opened: boolean; package: string | null; message: string }>(response),
    ),

  removeLibraryEntry: (id: string) =>
    fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((response) =>
      parse<{ removed: boolean }>(response),
    ),

  installLibraryEntry: (id: string) =>
    fetch(`/api/library/${encodeURIComponent(id)}/install`, { method: 'POST' }).then((response) =>
      parse<{ installed: boolean }>(response),
    ),

  inspectLibraryEntry: (id: string) =>
    fetch(`/api/library/${encodeURIComponent(id)}/inspect`).then((response) =>
      parse<{ file: ApkFileInfo; entry: LibraryEntry }>(response),
    ),

  verifyFile: (file: File, packageName?: string, version?: string, keep = false) => {
    const params = new URLSearchParams({ name: file.name });
    if (packageName) params.set('packageName', packageName);
    if (version) params.set('version', version);
    if (keep) params.set('keep', '1');
    return fetch(`/api/verify?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }).then((response) =>
      parse<{ file: ApkFileInfo; verification: VerificationResult; libraryEntry: LibraryEntry | null }>(response),
    );
  },
};

/** Subscribes to a job's server-sent events. Returns an unsubscribe function. */
export function watchJob(id: string, onJob: (job: DownloadJob) => void): () => void {
  const source = new EventSource(`/api/downloads/${encodeURIComponent(id)}/events`);
  const handle = (event: MessageEvent) => {
    try {
      onJob(JSON.parse(event.data) as DownloadJob);
    } catch {
      // ignore malformed frames
    }
  };
  source.addEventListener('job', handle as EventListener);
  source.addEventListener('end', () => source.close());
  source.onerror = () => source.close();
  return () => source.close();
}

export const libraryFileUrl = (id: string): string => `/api/library/${encodeURIComponent(id)}/file`;
