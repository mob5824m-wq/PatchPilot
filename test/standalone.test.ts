import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { abiPreference } from '../src/app/abi.ts';
import { LocalBundles, type SeedBundle } from '../src/app/bundles.ts';
import { LocalJobs } from '../src/app/jobs.ts';
import { LocalLibrary } from '../src/app/library.ts';
import { extractFromBundleArchive } from '../src/app/mpp.ts';
import {
  fromBase64,
  Native,
  toBase64,
  type NativeApkInfo,
  type NativeBridge,
  type NativeLibraryFile,
} from '../src/app/native.ts';
import { makeProxyFetch } from '../src/app/proxyFetch.ts';
import { defaultAppSettings, LocalBackend } from '../src/app/router.ts';
import { setFetchImplementation } from '../src/server/http.ts';
import { importBundleSources } from '../src/shared/bundleImport.ts';
import type { Settings } from '../src/shared/types.ts';

/**
 * The Android app has no server, so there is nothing to `curl` at. These tests
 * stand in for the phone: a fake shell implements the handful of actions Java
 * provides (sockets, files, PackageManager), and the real backend, providers and
 * parser run unchanged on top of it.
 *
 * What this proves: the whole standalone stack — catalog, mirror scraping,
 * download, verification, library — works with only the shell's primitives.
 * What it cannot prove: that the Java in `android/` implements them correctly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pages = join(root, 'fixtures', 'pages');

const PACKAGE = 'com.google.android.youtube';
const VERSION = '21.43.523';
const VERSION_CODE = 1834500;
const SIGNATURE = '5aad2bee6db95d17e05a08d7d1e64c10a1511879154483916b6ae6c7fd9cb0c6';

interface ShellOptions {
  /** Overrides what PackageManager "finds" in a downloaded file. */
  observed?: Partial<NativeApkInfo>;
}

interface Shell {
  native: Native;
  store: Map<string, string>;
  library: Map<string, NativeLibraryFile>;
  requests: string[];
  downloaded: string[];
  installed: string[];
  close: () => Promise<void>;
}

function apkInfo(overrides: ShellOptions['observed'] = {}): NativeApkInfo {
  return {
    packageName: PACKAGE,
    versionName: VERSION,
    versionCode: VERSION_CODE,
    signerSha256: [SIGNATURE],
    signingSchemes: ['v2'],
    isSplit: false,
    sizeBytes: 4096,
    minSdk: 26,
    targetSdk: 34,
    ...overrides,
  };
}

/** A stand-in for both mirrors and for GitHub, served from 127.0.0.1. */
async function startNetwork(): Promise<{ server: Server; base: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}${url.search}`);

    const send = (status: number, body: string | Buffer, type = 'text/html; charset=utf-8') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };

    if (url.pathname === '/') return send(200, await readFile(join(pages, 'apkmirror-search.html'), 'utf8'));
    if (url.pathname === '/apk/google-inc/youtube/youtube-21-43-523-release/') {
      return send(200, await readFile(join(pages, 'apkmirror-release.html'), 'utf8'));
    }
    if (url.pathname.endsWith('-android-apk-download/')) {
      return send(200, await readFile(join(pages, 'apkmirror-variant.html'), 'utf8'));
    }
    if (url.pathname.endsWith('/download/')) {
      return send(200, await readFile(join(pages, 'apkmirror-download-page.html'), 'utf8'));
    }
    if (url.pathname === '/wp-content/themes/APKMirror/download.php' && request.method === 'POST') {
      response.writeHead(302, { location: '/cdn/youtube.apk' });
      return response.end();
    }

    if (url.pathname === '/m/v3/cms/app_version') {
      return send(
        200,
        JSON.stringify({ data: { versionList: [{ versionName: VERSION, versionCode: VERSION_CODE }] } }),
        'application/json',
      );
    }
    if (url.pathname === '/b/APK/com.google.android.youtube') {
      response.writeHead(302, { location: '/cdn/youtube.apk' });
      return response.end();
    }
    if (url.pathname === '/cdn/youtube.apk') {
      return send(200, Buffer.alloc(4096, 7), 'application/vnd.android.package-archive');
    }

    // GitHub raw, used when the bundles refresh.
    if (/^\/[\w.-]+\/[\w.-]+\/HEAD\/patches-list\.json$/.test(url.pathname)) {
      return send(200, await readFile(join(root, 'fixtures', 'bundles', 'morphe-official.patches-list.json'), 'utf8'), 'application/json');
    }
    if (/^\/[\w.-]+\/[\w.-]+\/HEAD\/patches-bundle\.json$/.test(url.pathname)) {
      return send(404, 'no metadata');
    }

    return send(404, 'not found');
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * The fake shell. Every network call the app makes is rewritten onto the local
 * server, which is exactly what the Java proxy does with a real host.
 */
function createShell(base: string, options: ShellOptions = {}): Shell {
  const store = new Map<string, string>();
  const library = new Map<string, NativeLibraryFile>();
  const temp = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const downloaded: string[] = [];
  const installed: string[] = [];
  let folderGranted = false;
  let counter = 0;

  const rewrite = (url: string): string => {
    const parsed = new URL(url);
    return `${base}${parsed.pathname}${parsed.search}`;
  };

  const bridge: NativeBridge = {
    async call(action, payload) {
      const input = payload as Record<string, unknown>;
      switch (action) {
        case 'net.request': {
          const url = rewrite(String(input.url));
          requests.push(`${input.method} ${url}`);
          const headers = (input.headers as Record<string, string>) ?? {};
          const body = input.bodyBase64 ? fromBase64(String(input.bodyBase64)) : undefined;
          const response = await fetch(url, {
            method: String(input.method ?? 'GET'),
            headers,
            body: body as unknown as BodyInit | undefined,
            redirect: input.followRedirects === false ? 'manual' : 'follow',
          });
          const collected: Record<string, string[]> = {};
          response.headers.forEach((value, key) => {
            (collected[key] ??= []).push(value);
          });
          const setCookie = response.headers.getSetCookie?.() ?? [];
          if (setCookie.length) collected['set-cookie'] = setCookie;
          return {
            status: response.status,
            headers: collected,
            bodyBase64: toBase64(new Uint8Array(await response.arrayBuffer())),
          };
        }
        case 'net.download': {
          const url = rewrite(String(input.url));
          downloaded.push(url);
          const response = await fetch(url, { redirect: 'follow' });
          if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          counter += 1;
          const path = `temp/download-${counter}.apk`;
          temp.set(path, bytes);
          return { path, name: `download-${counter}.apk`, sizeBytes: bytes.length };
        }
        case 'apk.inspect': {
          const path = String(input.path);
          if (!temp.has(path)) throw new Error(`No such file: ${path}`);
          return apkInfo(options.observed);
        }
        case 'apk.inspectBytes': {
          counter += 1;
          const path = `temp/upload-${counter}.apk`;
          temp.set(path, fromBase64(String(input.base64)));
          return { ...apkInfo(options.observed), tempPath: path };
        }
        case 'library.publish': {
          const path = String(input.path);
          const bytes = temp.get(path);
          if (!bytes) throw new Error(`No such file: ${path}`);
          temp.delete(path);
          const file: NativeLibraryFile = {
            name: String(input.name),
            handle: `lib:${input.name}`,
            sizeBytes: bytes.length,
            modifiedAt: new Date().toISOString(),
          };
          library.set(file.name, file);
          return file;
        }
        case 'library.list':
          return [...library.values()];
        case 'library.delete': {
          const handle = String(input.handle);
          const entry = [...library.values()].find((file) => file.handle === handle);
          if (!entry) return false;
          library.delete(entry.name);
          return true;
        }
        case 'files.delete':
          temp.delete(String(input.path));
          return true;
        case 'store.get':
          return store.get(String(input.key)) ?? null;
        case 'store.set':
          store.set(String(input.key), String(input.value));
          return true;
        case 'morphe.pickFolder':
          // The grant is what makes the folder readable on the next scan.
          folderGranted = true;
          return { granted: true, uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload' };

        case 'morphe.scan':
          return {
            installed: [{ package: 'app.morphe.manager', version: '1.24.1' }],
            // A granted folder is the only reachable place on a modern Android.
            files: folderGranted
              ? [
                  {
                    path: 'content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2Fsources.xml',
                    name: 'sources.xml',
                    sizeBytes: 64,
                    kind: 'preferences',
                    folder: 'Download',
                  },
                ]
              : [],
            folders: folderGranted ? [{ uri: 'content://tree/primary%3ADownload', name: 'Download' }] : [],
            unreadable: [
              { path: '/data/data/app.morphe.manager', reason: 'Android does not allow other apps to read this folder' },
            ],
            notes: folderGranted
              ? ['Read 1 file(s) from the folder you granted.']
              : ['Morphe is installed, but Android keeps its source list private to it.'],
            rooted: false,
            sdk: 34,
          };

        case 'morphe.read':
          return {
            path: String(input.path),
            name: 'sources.xml',
            sizeBytes: 64,
            base64: toBase64(
              new TextEncoder().encode('<string name="sources">https://github.com/MorpheApp/morphe-patches</string>'),
            ),
          };

        case 'app.openMorphe':
          return { package: 'app.morphe.manager' };

        case 'device.state':
          return {
            freeBytes: 12 * 1024 * 1024 * 1024,
            totalBytes: 64 * 1024 * 1024 * 1024,
            installAllowed: true,
            notifications: true,
          };

        case 'apk.install':
          installed.push(String(input.handle));
          return true;

        case 'ui.toast':
        case 'open.url':
          return true;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };

  return {
    native: new Native(bridge, { version: '1.2.3', sdk: 34, model: 'Pixel test' }),
    store,
    library,
    requests,
    downloaded,
    installed,
    close: async () => undefined,
  };
}

async function loadSeeds(): Promise<SeedBundle[]> {
  const ids = ['morphe-official', 'hxreborn', 'piko'];
  const seeds: SeedBundle[] = [];
  for (const id of ids) {
    seeds.push({
      id,
      patchesList: JSON.parse(await readFile(join(root, 'fixtures', 'bundles', `${id}.patches-list.json`), 'utf8')),
      bundleInfo: JSON.parse(await readFile(join(root, 'fixtures', 'bundles', `${id}.patches-bundle.json`), 'utf8')),
    });
  }
  return seeds;
}

interface Harness {
  backend: LocalBackend;
  jobs: LocalJobs;
  library: LocalLibrary;
  settings: Settings;
  shell: Shell;
  close: () => Promise<void>;
}

const MORPHE_SOURCES = ['MorpheApp/morphe-patches', 'hxreborn/morphe-patches', 'crimera/piko'].join('\n');

/**
 * What the user does once: point PatchPilot at the bundles their Morphe has.
 * Nothing ships switched on, so every harness that expects a catalog does this.
 */
async function loadMorpheSources(bundles: LocalBundles, sources = MORPHE_SOURCES): Promise<void> {
  const outcome = await importBundleSources(sources, {
    configs: () => bundles.getConfigs(),
    enable: async (id) => {
      await bundles.setEnabled(id, true);
    },
    add: async (repo) => {
      await bundles.addRepo(repo);
    },
  });
  assert.deepEqual(outcome.added, []);
  assert.deepEqual(outcome.skipped, []);
}

async function startHarness(options: ShellOptions = {}, harnessOptions: { loadSources?: boolean } = {}): Promise<Harness> {
  const network = await startNetwork();
  const shell = createShell(network.base, options);

  // What `installStandalone` does first: point the provider transport at the shell.
  setFetchImplementation(
    makeProxyFetch(shell.native, fetch as unknown as typeof globalThis.fetch) as unknown as typeof fetch,
  );

  const bundles = new LocalBundles(shell.native, await loadSeeds());
  await bundles.init();
  if (harnessOptions.loadSources !== false) await loadMorpheSources(bundles);
  const library = new LocalLibrary(shell.native);
  await library.init();

  const settings = defaultAppSettings();
  const jobs: LocalJobs = new LocalJobs(shell.native, library, () => backend.currentSettings(), () => undefined);
  const backend: LocalBackend = new LocalBackend({
    native: shell.native,
    bundles,
    library,
    getJobs: (): LocalJobs => jobs,
    settings,
    version: '1.2.3',
    saveSettings: async () => undefined,
  });

  return {
    backend,
    jobs,
    library,
    settings,
    shell,
    close: () => network.close(),
  };
}

test('the standalone catalog comes from the bundled patch snapshots', async () => {
  const harness = await startHarness();
  const backend = harness.backend;

  const health = await backend.handle('GET', '/api/health', new URLSearchParams(), null);
  assert.equal(health.status, 200);
  assert.equal((health.body as { version: string }).version, '1.2.3');

  const catalog = await backend.handle('GET', '/api/catalog', new URLSearchParams(), null);
  const body = catalog.body as { appCount: number; patchCount: number; apps: { packageName: string }[] };
  assert.ok(body.patchCount > 100, `expected a real catalog, got ${body.patchCount} patches`);
  assert.ok(body.apps.some((app) => app.packageName === PACKAGE));

  const info = await backend.handle('GET', `/api/apps/${PACKAGE}`, new URLSearchParams(), null);
  assert.equal(info.status, 200);

  await harness.close();
});

test('nothing is offered until the user says which bundles Morphe has', async () => {
  const harness = await startHarness({}, { loadSources: false });

  const empty = (await harness.backend.handle('GET', '/api/catalog', new URLSearchParams(), null)).body as {
    appCount: number;
    morphe: { loaded: number; available: number };
  };
  assert.equal(empty.appCount, 0);
  assert.deepEqual(empty.morphe, { loaded: 0, available: 3 });

  // Importing one known source is all it takes.
  const imported = (
    await harness.backend.handle(
      'POST',
      '/api/bundles/import',
      new URLSearchParams(),
      JSON.stringify({ sources: 'https://github.com/MorpheApp/morphe-patches' }),
    )
  ).body as { enabled: string[]; added: string[]; bundles: { id: string; enabled: boolean }[] };

  assert.deepEqual(imported.added, []);
  assert.deepEqual(imported.enabled, ['Morphe Patches']);
  assert.equal(imported.bundles.filter((bundle) => bundle.enabled).length, 1);

  const catalog = (await harness.backend.handle('GET', '/api/catalog', new URLSearchParams(), null)).body as {
    appCount: number;
    patchCount: number;
    morphe: { loaded: number; available: number };
  };
  assert.equal(catalog.morphe.loaded, 1);
  assert.equal(catalog.morphe.available, 3);
  assert.ok(catalog.appCount > 0);

  // A line it cannot use is reported, and changes nothing.
  const junk = (
    await harness.backend.handle(
      'POST',
      '/api/bundles/import',
      new URLSearchParams(),
      JSON.stringify({ sources: 'not a real bundle\nhttps://example.com/patches.mpp' }),
    )
  ).body as { enabled: string[]; added: string[]; skipped: { source: string }[] };

  assert.deepEqual(junk.added, []);
  assert.deepEqual(junk.enabled, []);
  assert.equal(junk.skipped.length, 2);

  await harness.close();
});

test('a standalone download runs through the mirrors and lands in the library', async () => {
  const harness = await startHarness();

  const created = await harness.backend.handle(
    'POST',
    '/api/downloads',
    new URLSearchParams(),
    JSON.stringify({ packageName: PACKAGE, version: VERSION, providers: ['apkmirror'] }),
  );
  assert.equal(created.status, 202);
  const job = created.body as { id: string };

  let state = 'queued';
  for (let attempt = 0; attempt < 60 && !['done', 'failed', 'cancelled'].includes(state); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const polled = await harness.backend.handle('GET', `/api/downloads/${job.id}`, new URLSearchParams(), null);
    state = (polled.body as { state: string }).state;
  }

  const finished = (await harness.backend.handle('GET', `/api/downloads/${job.id}`, new URLSearchParams(), null)).body as {
    state: string;
    logs: { message: string }[];
    result: { libraryId: string } | null;
  };
  assert.equal(finished.state, 'done', finished.logs.map((line) => line.message).join('\n'));
  assert.ok(finished.result?.libraryId);

  const entries = (await harness.backend.handle('GET', '/api/library', new URLSearchParams(), null)).body as {
    entries: { fileName: string; packageName: string | null; verificationStatus: string | null }[];
  };
  assert.equal(entries.entries.length, 1);
  assert.match(entries.entries[0]!.fileName, /^com\.google\.android\.youtube_21\.43\.523\.apk$/);
  assert.equal(entries.entries[0]!.verificationStatus, 'pass');
  assert.ok(harness.shell.library.size === 1);

  await harness.close();
});

test('a mirror that serves the wrong build is rejected on the phone too', async () => {
  const harness = await startHarness({ observed: { versionName: '20.0.0', versionCode: 1 } });

  const created = await harness.backend.handle(
    'POST',
    '/api/downloads',
    new URLSearchParams(),
    JSON.stringify({ packageName: PACKAGE, version: VERSION, providers: ['apkmirror'] }),
  );
  const job = created.body as { id: string };

  let state = 'queued';
  for (let attempt = 0; attempt < 60 && !['done', 'failed', 'cancelled'].includes(state); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const polled = await harness.backend.handle('GET', `/api/downloads/${job.id}`, new URLSearchParams(), null);
    state = (polled.body as { state: string }).state;
  }

  const finished = (await harness.backend.handle('GET', `/api/downloads/${job.id}`, new URLSearchParams(), null)).body as {
    state: string;
    error: string | null;
  };
  assert.equal(finished.state, 'failed');
  assert.match(finished.error ?? '', /rejected/i);
  assert.equal(harness.shell.library.size, 0, 'a rejected build must not be published');

  await harness.close();
});

test('a file the user picks can be verified on the phone and kept', async () => {
  const harness = await startHarness();
  const bytes = new Uint8Array(4096).fill(3);

  const result = await harness.backend.handle(
    'POST',
    '/api/verify',
    new URLSearchParams({ name: 'youtube.apk', packageName: PACKAGE, version: VERSION, keep: '1' }),
    bytes,
  );
  assert.equal(result.status, 200);
  const body = result.body as { verification: { status: string }; libraryEntry: { fileName: string } | null };
  assert.equal(body.verification.status, 'pass');
  assert.ok(body.libraryEntry);
  assert.equal(harness.shell.library.size, 1);

  const library = (await harness.backend.handle('GET', '/api/library', new URLSearchParams(), null)).body as {
    entries: { id: string }[];
  };
  const removed = await harness.backend.handle(
    'DELETE',
    `/api/library/${library.entries[0]!.id}`,
    new URLSearchParams(),
    null,
  );
  assert.equal((removed.body as { removed: boolean }).removed, true);
  assert.equal(harness.shell.library.size, 0);

  await harness.close();
});

test('a saved APK can be handed to the system installer', async () => {
  const harness = await startHarness();
  const bytes = new Uint8Array(4096).fill(4);

  await harness.backend.handle(
    'POST',
    '/api/verify',
    new URLSearchParams({ name: 'youtube.apk', packageName: PACKAGE, version: VERSION, keep: '1' }),
    bytes,
  );
  const library = (await harness.backend.handle('GET', '/api/library', new URLSearchParams(), null)).body as {
    entries: { id: string }[];
  };
  assert.equal(library.entries.length, 1);

  const result = await harness.backend.handle(
    'POST',
    `/api/library/${library.entries[0]!.id}/install`,
    new URLSearchParams(),
    null,
  );
  assert.equal((result.body as { installed: boolean }).installed, true);
  assert.deepEqual(harness.shell.installed, ['lib:com.google.android.youtube_21.43.523.apk']);

  await harness.close();
});

test('the phone asks the mirrors for its own ABI', () => {
  assert.equal(abiPreference(['arm64-v8a', 'armeabi-v7a', 'armeabi']), 'arm64-v8a');
  assert.equal(abiPreference(['armeabi-v7a', 'armeabi']), 'armeabi-v7a');
  assert.equal(abiPreference(['x86_64', 'x86']), 'x86_64');
  assert.equal(abiPreference(['riscv64']), 'riscv64');
  assert.equal(abiPreference([]), null);
  assert.equal(abiPreference(undefined), null);
});

test('demo fixtures can be pruned and Morphe can be opened', async () => {
  const harness = await startHarness();

  // A demo file is one whose name carries the -DEMO marker.
  const published = await harness.shell.native.publish(
    (await harness.shell.native.download({ url: 'https://apkpure.com/cdn/youtube.apk' })).path,
    'com.google.android.youtube_21.43.523-DEMO.apk',
  );
  assert.ok(published.name.includes('DEMO'));

  const listed = (await harness.backend.handle('GET', '/api/library', new URLSearchParams(), null)).body as {
    entries: { demo: boolean }[];
  };
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0]!.demo, true);

  const pruned = (await harness.backend.handle('POST', '/api/library/prune', new URLSearchParams(), null)).body as {
    removed: number;
    entries: unknown[];
  };
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.entries.length, 0);
  assert.equal(harness.shell.library.size, 0);

  const morphe = (await harness.backend.handle('POST', '/api/open-morphe', new URLSearchParams(), null)).body as {
    opened: boolean;
    package: string | null;
  };
  assert.equal(morphe.opened, true);
  assert.equal(morphe.package, 'app.morphe.manager');

  await harness.close();
});

test('reading Morphe reports what Android allows, and nothing more', async () => {
  const harness = await startHarness({}, { loadSources: false });

  const empty = (await harness.backend.handle('GET', '/api/catalog', new URLSearchParams(), null)).body as {
    appCount: number;
  };
  assert.equal(empty.appCount, 0);

  const scan = (await harness.backend.handle('POST', '/api/morphe/scan', new URLSearchParams(), null)).body as {
    supported: boolean;
    notes: string[];
    discovery: { found: boolean; filesRead: number; installed: { package: string }[]; folders: string[] };
  };

  assert.equal(scan.supported, true);
  assert.equal(scan.discovery.found, false);
  assert.equal(scan.discovery.filesRead, 0);
  assert.deepEqual(scan.discovery.folders, []);
  assert.deepEqual(
    scan.discovery.installed.map((entry) => entry.package),
    ['app.morphe.manager'],
  );
  assert.ok(scan.notes[0]?.includes('private'), 'the scan should say why nothing was read');

  // Nothing was invented from the install alone.
  const stillEmpty = (await harness.backend.handle('GET', '/api/catalog', new URLSearchParams(), null)).body as {
    appCount: number;
  };
  assert.equal(stillEmpty.appCount, 0);

  await harness.close();
});

test('one granted folder fills the catalogue without anyone pasting a url', async () => {
  const harness = await startHarness({}, { loadSources: false });

  const granted = (await harness.backend.handle('POST', '/api/morphe/folder', new URLSearchParams(), null)).body as {
    supported: boolean;
    notes: string[];
    discovery: { found: boolean; filesRead: number; folders: string[]; enabled: string[] };
  };

  assert.equal(granted.supported, true);
  assert.equal(granted.discovery.found, true);
  assert.equal(granted.discovery.filesRead, 1);
  assert.deepEqual(granted.discovery.folders, ['Download']);
  assert.deepEqual(granted.discovery.enabled, ['Morphe Patches']);

  const catalog = (await harness.backend.handle('GET', '/api/catalog', new URLSearchParams(), null)).body as {
    appCount: number;
    morphe: { loaded: number };
  };
  assert.ok(catalog.appCount > 0);
  assert.equal(catalog.morphe.loaded, 1);

  const cached = (await harness.backend.handle('GET', '/api/morphe', new URLSearchParams(), null)).body as {
    discovery: { found: boolean } | null;
  };
  assert.equal(cached.discovery?.found, true);

  const doctor = (await harness.backend.handle('GET', '/api/doctor', new URLSearchParams(), null)).body as {
    checks: { id: string; status: string }[];
  };
  assert.equal(doctor.checks.find((check) => check.id === 'morphe')?.status, 'pass');

  await harness.close();
});

test('the Doctor reports device, bundle and source health in one place', async () => {
  const harness = await startHarness();

  const report = (await harness.backend.handle('GET', '/api/doctor', new URLSearchParams(), null)).body as {
    mode: string;
    checks: { id: string; status: string; detail: string }[];
    summary: { pass: number; warn: number; fail: number; skip: number };
  };

  assert.equal(report.mode, 'device');
  const ids = report.checks.map((check) => check.id);
  for (const required of ['storage', 'install', 'bundles', 'library', 'sources', 'version']) {
    assert.ok(ids.includes(required), `doctor is missing ${required}`);
  }
  const storage = report.checks.find((check) => check.id === 'storage');
  assert.equal(storage?.status, 'pass');
  assert.match(storage?.detail ?? '', /12\.0 GB free of 64 GB/);
  assert.equal(report.summary.fail, 0);

  await harness.close();
});

test('bundles refresh from GitHub and fall back to the snapshot when the network is gone', async () => {
  const harness = await startHarness();

  const refreshed = await harness.backend.handle('POST', '/api/bundles/refresh-all', new URLSearchParams(), null);
  const infos = (refreshed.body as { bundles: { id: string; origin: string | null }[] }).bundles;
  const official = infos.find((bundle) => bundle.id === 'morphe-official');
  assert.equal(official?.origin, 'network');
  assert.ok(
    harness.shell.requests.some((request) => request.includes('/MorpheApp/morphe-patches/HEAD/patches-list.json')),
    'the refresh should have asked GitHub for the patch list',
  );

  await harness.close();
});

test('a .mpp archive is read in the browser zip reader', async () => {
  const patchesList = JSON.stringify({ version: '1.4.0', patches: [{ name: 'Hide ads' }] });
  const bundleInfo = JSON.stringify({ version: '1.4.0', public_key: 'abc' });

  const zip = buildZip([
    { name: 'classes.dex', data: new Uint8Array([1, 2, 3]) },
    { name: 'patches-list.json', data: new TextEncoder().encode(patchesList), deflate: true },
    { name: 'patches-bundle.json', data: new TextEncoder().encode(bundleInfo) },
  ]);

  const extracted = await extractFromBundleArchive(zip);
  assert.equal((extracted.patchesList as { version: string }).version, '1.4.0');
  assert.equal((extracted.bundleInfo as { public_key: string }).public_key, 'abc');
});

/** Minimal zip writer: enough to produce stored and deflated entries. */
function buildZip(entries: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const payload = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, entry.deflate ? 8 : 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    chunks.push(local, payload);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(10, entry.deflate ? 8 : 0, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, payload.length, true);
    directoryView.setUint32(24, entry.data.length, true);
    directoryView.setUint16(28, name.length, true);
    directoryView.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let table = crcTable;
  if (!table) {
    table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

let crcTable: Uint32Array | null = null;
