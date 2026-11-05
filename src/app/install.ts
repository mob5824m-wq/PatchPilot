import morpheList from '../../fixtures/bundles/morphe-official.patches-list.json';
import morpheMeta from '../../fixtures/bundles/morphe-official.patches-bundle.json';
import hxrebornList from '../../fixtures/bundles/hxreborn.patches-list.json';
import hxrebornMeta from '../../fixtures/bundles/hxreborn.patches-bundle.json';
import pikoList from '../../fixtures/bundles/piko.patches-list.json';
import pikoMeta from '../../fixtures/bundles/piko.patches-bundle.json';
import { setFetchImplementation, setUserAgent } from '../server/http.ts';
import { buildUserAgent } from '../shared/userAgent.ts';
import { LocalBundles, type SeedBundle } from './bundles.ts';
import { LocalJobs } from './jobs.ts';
import { LocalLibrary } from './library.ts';
import { androidBridge, androidDevice, hasAndroidShell, Native } from './native.ts';
import { makeProxyFetch } from './proxyFetch.ts';
import { loadAppSettings, LocalBackend } from './router.ts';

/**
 * Turns the same React UI into a standalone Android app.
 *
 * Nothing below the UI is aware of the platform: the page keeps calling
 * `/api/...`, and this file answers those calls on the device. The three things
 * only Android can do — real sockets, the filesystem, and asking PackageManager
 * what an APK is — go through the shell.
 *
 * On a desktop the module is inert: `hasAndroidShell()` is false and the app
 * talks to the Node server exactly as before.
 */

const SEEDS: SeedBundle[] = [
  { id: 'morphe-official', patchesList: morpheList, bundleInfo: morpheMeta },
  { id: 'hxreborn', patchesList: hxrebornList, bundleInfo: hxrebornMeta },
  { id: 'piko', patchesList: pikoList, bundleInfo: pikoMeta },
];

/** `/api/*` requests are answered here instead of by a server. */
function installFetchShim(backend: LocalBackend): void {
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return original(input as RequestInfo, init);
    }

    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) {
      const body = init.body ?? null;
      const result = await backend.handle(init.method ?? 'GET', parsed.pathname, parsed.searchParams, body);
      return new Response(JSON.stringify(result.body ?? null), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    return original(input as RequestInfo, init);
  };
}

/** `EventSource` for job progress, backed by polling the in-page backend. */
class LocalJobEvents extends EventTarget {
  private timer: number | null = null;
  private closed = false;
  readonly readyState = 1;

  constructor(private readonly backend: LocalBackend, private readonly id: string) {
    super();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const result = await this.backend.handle('GET', `/api/downloads/${encodeURIComponent(this.id)}`, new URLSearchParams(), null);
      if (result.status === 200 && result.body) {
        this.dispatchEvent(new MessageEvent('job', { data: JSON.stringify(result.body) }));
        const state = (result.body as { state?: string }).state;
        if (state && ['done', 'failed', 'cancelled'].includes(state)) {
          this.dispatchEvent(new MessageEvent('end', { data: '{}' }));
          this.close();
          return;
        }
      }
    } catch {
      // Keep polling; the job may still be running.
    }
    this.timer = window.setTimeout(() => void this.poll(), 600);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

function installEventSourceShim(backend: LocalBackend): void {
  const Original = window.EventSource;
  void Original;

  class PatchedEventSource extends LocalJobEvents {
    constructor(url: string | URL) {
      const path = typeof url === 'string' ? url : url.href;
      const match = /\/api\/downloads\/([^/]+)\/events/.exec(path);
      super(backend, match?.[1] ? decodeURIComponent(match[1]) : '');
    }
  }

  (window as unknown as { EventSource: unknown }).EventSource = PatchedEventSource;
}

/**
 * The library file link points at `/api/library/:id/file` on a server. On the
 * phone the file is already in Downloads/PatchPilot, so the link becomes a
 * reminder instead of a navigation that would leave the app.
 */
function installDownloadLinkGuard(native: Native): void {
  document.addEventListener(
    'click',
    (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/\/api\/library\/[^/]+\/file/.test(href)) return;
      event.preventDefault();
      void native.toast('Already saved to Downloads/PatchPilot');
    },
    true,
  );
}

export async function installStandalone(): Promise<boolean> {
  if (!hasAndroidShell()) return false;

  const shell = (window as unknown as { PatchPilotNative: { call: (id: string, action: string, payload: string) => void } })
    .PatchPilotNative;
  const device = androidDevice();
  const native = new Native(androidBridge(shell), device);

  setUserAgent(buildUserAgent(`android-${device.version}`));

  // Providers reach mirrors through the shell: the WebView cannot, and the
  // mirrors do not send CORS headers anyway.
  setFetchImplementation(makeProxyFetch(native, window.fetch.bind(window)) as unknown as typeof fetch);

  const bundles = new LocalBundles(native, SEEDS);
  await bundles.init();

  const library = new LocalLibrary(native);
  await library.init();

  const settings = await loadAppSettings(native);
  const jobs: LocalJobs = new LocalJobs(native, library, () => backend.currentSettings(), () => undefined);

  const backend: LocalBackend = new LocalBackend({
    native,
    bundles,
    library,
    getJobs: (): LocalJobs => jobs,
    settings,
    version: device.version,
    saveSettings: async (next) => {
      await native.setStore('settings.v1', JSON.stringify(next));
    },
  });

  installFetchShim(backend);
  installEventSourceShim(backend);
  installDownloadLinkGuard(native);

  // Refresh the bundles once the first screen is up, so the phone starts from
  // the bundled snapshot and improves from there.
  window.setTimeout(() => bundles.refreshInBackground(), 1_500);
  return true;
}

export { LocalBackend };
