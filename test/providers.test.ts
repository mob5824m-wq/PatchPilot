import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Settings } from '../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..', 'fixtures', 'pages');

const dataDir = await mkdtemp(join(tmpdir(), 'patchpilot-providers-'));
process.env.PATCHPILOT_DATA_DIR = dataDir;

const { buildApk, testCertificateSha256 } = await import('../src/core/apk/fixture.ts');
const { ApkMirrorProvider } = await import('../src/core/providers/apkmirror.ts');
const { ApkPureProvider } = await import('../src/core/providers/apkpure.ts');
const {
  pickDownloadForm,
  pickKeyedDownloadLinks,
  pickReleaseLinks,
  pickVariantLinks,
  scoreVariant,
  versionSlugs,
  looksBlocked,
} = await import('../src/core/providers/apkmirrorParse.ts');
const {
  directDownloadUrls,
  parseVersionList,
  pickAppPages,
  pickVersionLinks,
} = await import('../src/core/providers/apkpureParse.ts');


const PACKAGE = 'com.google.android.youtube';
const VERSION = '21.43.523';
const VERSION_CODE = 1834500;

const apkBytes = buildApk({ packageName: PACKAGE, versionName: VERSION, versionCode: VERSION_CODE });

/* ------------------------------------------------------------------ parsers --- */

test('APKMirror release links are matched by version slug, not just text', () => {
  const html = `
    <a href="/apk/google-inc/youtube/youtube-21-43-523-release/">YouTube 21.43.523</a>
    <a href="/apk/google-inc/youtube/youtube-21-30-216-release/">YouTube 21.30.216</a>`;

  const matched = pickReleaseLinks(html, 'https://www.apkmirror.com/', '21.43.523');
  assert.equal(matched.length, 1);
  assert.match(matched[0]!.url, /21-43-523/);

  // Two-digit segments must not collide with longer ones (21.4.3 vs 21.43.523).
  const none = pickReleaseLinks(html, 'https://www.apkmirror.com/', '21.4.3');
  assert.equal(none.length, 0);
});

test('APKMirror version slugs cover dotted, dashed and squashed forms', () => {
  assert.deepEqual(versionSlugs('21.43.523'), ['21-43-523', '2143523']);
  assert.deepEqual(versionSlugs('2.1.0-dev.9'), ['2-1-0-dev-9', '210dev9']);
});

test('variant scoring prefers nodpi for APKs and bundles for split formats', () => {
  const nodpi = { url: 'https://www.apkmirror.com/x/youtube-21-android-apk-download/', text: 'nodpi arm64-v8a', href: '' };
  const bundle = { url: 'https://www.apkmirror.com/x/youtube-21-bundle-download/', text: 'BUNDLE nodpi', href: '' };
  const x86 = { url: 'https://www.apkmirror.com/x/youtube-21-x86-android-apk-download/', text: 'x86 nodpi', href: '' };

  assert.ok(scoreVariant(nodpi, 'APK_REQUIRED', 'arm64-v8a') > scoreVariant(x86, 'APK_REQUIRED', 'arm64-v8a'));
  assert.ok(scoreVariant(bundle, 'APKS_REQUIRED', null) > scoreVariant(nodpi, 'APKS_REQUIRED', null));
  assert.ok(scoreVariant(nodpi, 'APK_REQUIRED', null) > scoreVariant(bundle, 'APK_REQUIRED', null));
});

test('the download form is picked out from other forms on the page', async () => {
  const html = await readFile(join(pages, 'apkmirror-download-page.html'), 'utf8');
  const form = pickDownloadForm(html, 'https://www.apkmirror.com/x/download/?key=b7e2c4d19f');
  assert.ok(form);
  assert.match(form!.action, /download\.php$/);
  assert.equal(form!.method, 'post');
  assert.deepEqual(
    form!.fields.map((field) => `${field.name}=${field.value}`),
    ['id=1987654', 'key=b7e2c4d19f', 'supported_abis=arm64-v8a,armeabi-v7a'],
  );
});

test('variant pages expose the keyed download link', async () => {
  const html = await readFile(join(pages, 'apkmirror-variant.html'), 'utf8');
  const links = pickKeyedDownloadLinks(html, 'https://www.apkmirror.com/apk/google-inc/youtube/youtube-21-43-523-release/youtube-21-43-523-android-apk-download/');
  assert.equal(links.length, 1);
  assert.match(links[0]!.url, /\/download\/\?key=b7e2c4d19f$/);
});

test('release pages list every variant', async () => {
  const html = await readFile(join(pages, 'apkmirror-release.html'), 'utf8');
  const variants = pickVariantLinks(html, 'https://www.apkmirror.com/apk/google-inc/youtube/youtube-21-43-523-release/');
  assert.ok(variants.length >= 3);
  assert.ok(variants.some((variant) => /nodpi|x86/.test(variant.url)));
});

test('Cloudflare interstitials are recognised', () => {
  assert.ok(looksBlocked('<title>Just a moment...</title>', 200));
  assert.ok(looksBlocked('', 403));
  assert.ok(!looksBlocked('<html>normal</html>', 200));
});

test('APKPure version lists are read from several payload shapes', () => {
  const modern = parseVersionList({
    data: { versionList: [{ versionName: '21.43.523', versionCode: 1834500, downloadUrl: 'https://x/y.apk' }] },
  });
  assert.equal(modern.length, 1);
  assert.equal(modern[0]!.versionCode, 1834500);
  assert.deepEqual(modern[0]!.urls, ['https://x/y.apk']);

  const bare = parseVersionList([{ version_name: '1.2.3', version_code: '456' }]);
  assert.equal(bare[0]!.versionName, '1.2.3');
  assert.equal(bare[0]!.versionCode, 456);

  const nested = parseVersionList({ data: { apk: { version: { versionName: '9.9', versionCode: 7 } } } });
  assert.ok(nested.some((entry) => entry.versionName === '9.9'));
});

test('APKPure download URLs carry the version code and bundle keyword', () => {
  const apk = directDownloadUrls('com.example.app', 'APK', { versionCode: 123 });
  assert.equal(apk[0]!.url, 'https://d.apkpure.com/b/APK/com.example.app?versionCode=123');

  const xapk = directDownloadUrls('com.example.app', 'XAPK', { versionName: '1.2.3' });
  assert.equal(xapk[0]!.url, 'https://d.apkpure.com/b/XAPK/com.example.app?version=1.2.3');
});

test('APKPure versions page rows are matched by code and by name', async () => {
  const html = await readFile(join(pages, 'apkpure-versions.html'), 'utf8');
  const byCode = pickVersionLinks(html, 'https://apkpure.com/youtube/com.google.android.youtube/versions', {
    versionName: null,
    versionCodes: [1830216],
  });
  assert.equal(byCode.length, 1);
  assert.match(byCode[0]!.url, /versionCode=1830216/);

  const byName = pickVersionLinks(html, 'https://apkpure.com/youtube/com.google.android.youtube/versions', {
    versionName: '21.23.492',
    versionCodes: [],
  });
  assert.equal(byName.length, 1);
});

test('APKPure search results yield app pages', async () => {
  const html = await readFile(join(pages, 'apkpure-search.html'), 'utf8');
  const appPages = pickAppPages(html, 'https://apkpure.com/search?q=com.google.android.youtube', PACKAGE);
  assert.ok(appPages.some((page) => page.url.includes(PACKAGE)));
});

/* ------------------------------------------------------------- local mirror --- */

interface Mirror {
  server: Server;
  base: string;
  requests: string[];
  close: () => Promise<void>;
}

/**
 * A stand-in for both mirrors: same paths, same shapes, but served from
 * 127.0.0.1 so the whole provider flow — search, release, variant, form POST,
 * redirect, download — can be exercised without touching the real sites.
 */
async function startMirror(options: { apkpureHasUrls: boolean; apkmirrorBlocked?: boolean }): Promise<Mirror> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}${url.search}`);

    const send = (status: number, body: string | Buffer, type = 'text/html; charset=utf-8') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };

    if (options.apkmirrorBlocked && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/b/')) {
      return send(200, '<html><head><title>Just a moment...</title></head><body>cf-challenge</body></html>');
    }

    // ---- APKMirror ----
    if (url.pathname === '/') {
      return send(200, await readFile(join(pages, 'apkmirror-search.html'), 'utf8'));
    }
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
      response.writeHead(302, { location: '/cdn/apkmirror-21-43-523.apk' });
      return response.end();
    }

    // ---- APKPure ----
    if (url.pathname === '/m/v3/cms/app_version') {
      const payload = {
        data: {
          versionList: [
            {
              versionName: VERSION,
              versionCode: VERSION_CODE,
              ...(options.apkpureHasUrls
                ? { downloadUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn/apkpure-1834500.apk` }
                : {}),
            },
          ],
        },
      };
      return send(200, JSON.stringify(payload), 'application/json');
    }
    if (url.pathname === '/search') {
      return send(200, await readFile(join(pages, 'apkpure-search.html'), 'utf8'));
    }
    if (url.pathname === '/youtube/com.google.android.youtube/versions') {
      return send(200, await readFile(join(pages, 'apkpure-versions.html'), 'utf8'));
    }
    if (url.pathname === '/b/APK/com.google.android.youtube') {
      if (url.searchParams.get('versionCode') !== String(VERSION_CODE)) return send(404, 'no such build');
      response.writeHead(302, { location: '/cdn/apkpure-1834500.apk' });
      return response.end();
    }

    // ---- files ----
    if (url.pathname === '/cdn/apkmirror-21-43-523.apk' || url.pathname === '/cdn/apkpure-1834500.apk') {
      return send(200, apkBytes, 'application/vnd.android.package-archive');
    }

    return send(404, 'not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('APKMirror provider walks search → release → variant → form → file', async () => {
  const mirror = await startMirror({ apkpureHasUrls: false });
  try {
    const provider = new ApkMirrorProvider({ site: mirror.base });
    const result = await provider.resolve({
      packageName: PACKAGE,
      appName: 'YouTube',
      versionName: VERSION,
      versionCodes: { ARM64_V8A: VERSION_CODE },
      fileType: 'APK_REQUIRED',
      preferAbi: 'arm64-v8a',
      log: () => undefined,
    });

    assert.ok(result.files.length > 0, result.detail);
    assert.match(result.files[0]!.url, /\/cdn\/apkmirror-21-43-523\.apk$/);

    // The chain really posted the form rather than guessing a URL.
    assert.ok(mirror.requests.some((entry) => entry.startsWith('POST /wp-content/themes/APKMirror/download.php')));
    assert.ok(mirror.requests.some((entry) => entry.includes('s=com.google.android.youtube')));
    assert.ok(result.pages.length > 0);
  } finally {
    await mirror.close();
  }
});

test('APKMirror reports a Cloudflare challenge instead of pretending to fail silently', async () => {
  const mirror = await startMirror({ apkpureHasUrls: false, apkmirrorBlocked: true });
  try {
    const provider = new ApkMirrorProvider({ site: mirror.base });
    const result = await provider.resolve({
      packageName: PACKAGE,
      appName: 'YouTube',
      versionName: VERSION,
      versionCodes: null,
      fileType: 'APK_REQUIRED',
      preferAbi: null,
      log: () => undefined,
    });
    assert.equal(result.files.length, 0);
    assert.match(result.detail, /Cloudflare/i);
    assert.ok(result.pages.some((page) => page.url.includes('searchtype=apk')));
  } finally {
    await mirror.close();
  }
});

test('APKPure provider uses the URL from the version list', async () => {
  const mirror = await startMirror({ apkpureHasUrls: true });
  try {
    const provider = new ApkPureProvider({ site: mirror.base, apiHost: mirror.base, downloadHost: mirror.base });
    const result = await provider.resolve({
      packageName: PACKAGE,
      appName: 'YouTube',
      versionName: VERSION,
      versionCodes: null,
      fileType: 'APK_REQUIRED',
      preferAbi: null,
      log: () => undefined,
    });
    assert.ok(result.files.length > 0, result.detail);
    assert.match(result.files[0]!.url, /\/cdn\/apkpure-1834500\.apk$/);
    assert.match(result.detail, /version list knows 21\.43\.523/);
  } finally {
    await mirror.close();
  }
});

test('APKPure provider falls back to the download host redirect', async () => {
  const mirror = await startMirror({ apkpureHasUrls: false });
  try {
    const provider = new ApkPureProvider({ site: mirror.base, apiHost: mirror.base, downloadHost: mirror.base });
    const result = await provider.resolve({
      packageName: PACKAGE,
      appName: 'YouTube',
      versionName: VERSION,
      versionCodes: { ARM64_V8A: VERSION_CODE },
      fileType: 'APK_REQUIRED',
      preferAbi: null,
      log: () => undefined,
    });
    assert.ok(result.files.length > 0, result.detail);
    assert.match(result.files[0]!.url, /\/cdn\/apkpure-1834500\.apk$/);
    assert.match(result.detail, /redirects straight to apkpure-1834500\.apk/);
  } finally {
    await mirror.close();
  }
});

test('APKPure provider scrapes the versions page when the API is empty', async () => {
  const mirror = await startMirror({ apkpureHasUrls: false });
  try {
    // No API host reachable: the provider must fall back to the public pages.
    const provider = new ApkPureProvider({
      site: mirror.base,
      apiHost: 'http://127.0.0.1:1',
      downloadHost: 'http://127.0.0.1:1',
    });
    const result = await provider.resolve({
      packageName: PACKAGE,
      appName: 'YouTube',
      versionName: VERSION,
      versionCodes: { ARM64_V8A: VERSION_CODE },
      fileType: 'APK_REQUIRED',
      preferAbi: null,
      log: () => undefined,
    });
    assert.ok(result.files.length > 0, result.detail);
    assert.ok(result.files.some((file) => /versionCode=1834500/.test(file.url)));
    assert.match(result.detail, /versions page supplied/);
  } finally {
    await mirror.close();
  }
});



test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
