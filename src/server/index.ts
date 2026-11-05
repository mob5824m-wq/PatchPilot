import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  ApkFileType,
  CatalogResponse,
  DownloadJob,
  HealthResponse,
  Settings,
} from '../shared/types.ts';
import { describeApk, verifyApk, type ExpectedApp } from './apk/verify.ts';
import { buildAppDetail, buildCatalog } from './catalog.ts';
import {
  APP_VERSION,
  BUILD_COMMIT,
  dataDir,
  demoSourceEnabled,
  ensureDirs,
  isDev,
  libraryDir,
  loadSettings,
  offlineMode,
  port,
  repoRoot,
  saveSettings,
} from './config.ts';
import { BundleRegistry } from './bundles/registry.ts';
import { JobManager } from './jobs.ts';
import { addToLibrary, listLibrary, libraryFilePath, pruneLibrary, removeFromLibrary } from './library.ts';
import { providerStatus, probeProvider } from './providers/index.ts';
import { HttpError } from './http.ts';

const app = express();
app.disable('x-powered-by');

ensureDirs();

const registry = new BundleRegistry();
let settings: Settings = await loadSettings();
const jobs = new JobManager(async () => settings);

let catalogCache: CatalogResponse | null = null;
function catalog(): CatalogResponse {
  if (!catalogCache) catalogCache = buildCatalog(registry.getPayloads());
  return catalogCache;
}
function invalidateCatalog(): void {
  catalogCache = null;
}

await registry.init();

// Refresh bundles in the background on start; the seeded snapshot keeps the UI usable meanwhile.
if (!offlineMode) void registry.refresh().then(() => invalidateCatalog());

app.use(express.json({ limit: '2mb' }));

const json = (response: Response, value: unknown, status = 200): void => {
  response.status(status).json(value);
};

const fail = (response: Response, error: unknown, status = 400): void => {
  const message = error instanceof HttpError ? error.message : (error as Error).message;
  json(response, { error: message }, status);
};

/* ------------------------------------------------------------------ health --- */

app.get('/api/health', (_request, response) => {
  const warnings: string[] = [];
  if (demoSourceEnabled) warnings.push('Offline demo source is enabled: generated fixtures are stand-ins, not real apps.');
  json(response, {
    ok: true,
    version: APP_VERSION,
    commit: BUILD_COMMIT,
    demoSource: demoSourceEnabled,
    dataDir,
    libraryDir,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    warnings,
  } satisfies HealthResponse);
});

/* ----------------------------------------------------------------- catalog --- */

app.get('/api/catalog', (request, response) => {
  if (request.query.refresh === '1') invalidateCatalog();
  json(response, catalog());
});

app.get('/api/apps/:packageName', (request, response) => {
  const detail = buildAppDetail(registry.getPayloads(), request.params.packageName);
  if (!detail) return json(response, { error: 'Unknown package' }, 404);
  json(response, detail);
});

app.post('/api/resolve', async (request, response) => {
  const { packageName, version } = request.body as { packageName?: string; version?: string };
  if (!packageName) return json(response, { error: 'packageName is required' }, 400);

  const app = catalog().apps.find((entry) => entry.packageName === packageName);
  if (!app) return json(response, { error: 'Unknown package' }, 404);
  const target = app.targets.find((entry) => entry.version === version) ?? app.targets[0];
  if (!target) return json(response, { error: 'No supported version for this app' }, 404);

  const { activeProviders } = await import('./providers/index.ts');
  const providers = activeProviders(settings);
  const candidates = [];
  for (const provider of providers) {
    try {
      const result = await provider.resolve({
        packageName,
        appName: app.name,
        versionName: target.version,
        versionCodes: target.versionCodes,
        fileType: app.fileType,
        preferAbi: settings.preferAbi,
        log: () => undefined,
      });
      for (const file of result.files) {
        candidates.push({
          providerId: provider.id,
          providerLabel: provider.label,
          kind: 'file' as const,
          url: file.url,
          label: file.label,
          status: 'ok' as const,
          detail: result.detail,
        });
      }
      for (const page of result.pages) {
        candidates.push({
          providerId: provider.id,
          providerLabel: provider.label,
          kind: 'page' as const,
          url: page.url,
          label: page.label,
          status: 'ok' as const,
          detail: result.detail,
        });
      }
      if (!result.files.length && !result.pages.length) {
        candidates.push({
          providerId: provider.id,
          providerLabel: provider.label,
          kind: 'page' as const,
          url: provider.homepage,
          label: provider.label,
          status: 'empty' as const,
          detail: result.detail,
        });
      }
    } catch (error) {
      candidates.push({
        providerId: provider.id,
        providerLabel: provider.label,
        kind: 'page' as const,
        url: provider.homepage,
        label: provider.label,
        status: 'error' as const,
        detail: (error as Error).message,
      });
    }
  }
  json(response, { packageName, version: target.version, candidates });
});

/* ----------------------------------------------------------------- bundles --- */

app.get('/api/bundles', (_request, response) => {
  json(response, { bundles: registry.getInfos() });
});

app.post('/api/bundles', async (request, response) => {
  try {
    const { repo, name } = request.body as { repo?: string; name?: string };
    if (!repo) throw new Error('repo is required (owner/name)');
    const info = await registry.addGithubBundle(repo, name);
    invalidateCatalog();
    json(response, info, 201);
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/bundles/upload', express.raw({ type: '*/*', limit: '256mb' }), async (request, response) => {
  try {
    const bytes = request.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('No file received');
    const name = String(request.query.name ?? 'uploaded-bundle.mpp');
    const info = await registry.addUploadedBundle(name, bytes);
    invalidateCatalog();
    json(response, info, 201);
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/bundles/refresh-all', async (_request, response) => {
  try {
    await registry.refresh();
    invalidateCatalog();
    json(response, { bundles: registry.getInfos() });
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/bundles/:id/refresh', async (request, response) => {
  try {
    await registry.refresh(request.params.id);
    invalidateCatalog();
    json(response, { bundles: registry.getInfos() });
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/bundles/:id/enabled', async (request, response) => {
  try {
    const { enabled } = request.body as { enabled?: boolean };
    await registry.setEnabled(request.params.id, enabled !== false);
    invalidateCatalog();
    json(response, { bundles: registry.getInfos() });
  } catch (error) {
    fail(response, error);
  }
});

app.delete('/api/bundles/:id', async (request, response) => {
  try {
    const removed = await registry.remove(request.params.id);
    invalidateCatalog();
    json(response, { removed });
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/bundles/reset', async (_request, response) => {
  try {
    await registry.resetToDefaults();
    invalidateCatalog();
    json(response, { bundles: registry.getInfos() });
  } catch (error) {
    fail(response, error);
  }
});

/* --------------------------------------------------------------- providers --- */

app.get('/api/providers', (_request, response) => {
  json(response, { providers: providerStatus(settings) });
});

app.post('/api/providers/:id/probe', async (request, response) => {
  try {
    json(response, await probeProvider(request.params.id));
  } catch (error) {
    fail(response, error);
  }
});

app.post('/api/providers/:id/enabled', async (request, response) => {
  const { enabled } = request.body as { enabled?: boolean };
  const providers = providerStatus(settings);
  const existing = providers.find((provider) => provider.id === request.params.id);
  if (!existing) return json(response, { error: 'Unknown provider' }, 404);
  settings = {
    ...settings,
    demoSource: request.params.id === 'demo' ? enabled !== false : settings.demoSource,
    providers: {
      ...settings.providers,
      [request.params.id]: { enabled: enabled !== false, order: existing.order },
    },
  };
  await saveSettings(settings);
  json(response, { providers: providerStatus(settings) });
});

app.post('/api/providers/order', async (request, response) => {
  const { order } = request.body as { order?: string[] };
  if (!Array.isArray(order)) return json(response, { error: 'order must be an array of provider ids' }, 400);
  const next: Settings['providers'] = { ...settings.providers };
  order.forEach((id, index) => {
    next[id] = { enabled: settings.providers[id]?.enabled ?? true, order: (index + 1) * 10 };
  });
  settings = { ...settings, providers: next };
  await saveSettings(settings);
  json(response, { providers: providerStatus(settings) });
});

/* ---------------------------------------------------------------- settings --- */

app.get('/api/settings', (_request, response) => {
  json(response, settings);
});

app.put('/api/settings', async (request, response) => {
  const body = request.body as Partial<Settings>;
  settings = {
    ...settings,
    ...body,
    providers: { ...settings.providers, ...(body.providers ?? {}) },
  };
  await saveSettings(settings);
  json(response, settings);
});

/* ------------------------------------------------------------------- jobs --- */

app.post('/api/downloads', (request, response) => {
  const body = request.body as {
    packageName?: string;
    version?: string;
    providers?: string[];
  };
  if (!body.packageName) return json(response, { error: 'packageName is required' }, 400);

  const app = catalog().apps.find((entry) => entry.packageName === body.packageName);
  if (!app) return json(response, { error: 'Unknown package' }, 404);

  const target = body.version
    ? app.targets.find((entry) => entry.version === body.version)
    : app.targets.find((entry) => entry.version === app.recommendedVersion);

  if (body.version && !target) {
    return json(response, { error: `${app.name} ${body.version} is not supported by the loaded patches` }, 400);
  }

  const job = jobs.create({
    packageName: app.packageName,
    appName: app.name,
    version: target?.version ?? null,
    versionCodes: target?.versionCodes ?? null,
    fileType: app.fileType,
    signatures: app.signatures,
    providers: body.providers ?? null,
  });
  json(response, job, 202);
});

app.get('/api/downloads', (_request, response) => {
  json(response, { jobs: jobs.list() });
});

app.get('/api/downloads/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return json(response, { error: 'Unknown job' }, 404);
  json(response, job);
});

app.post('/api/downloads/:id/cancel', (request, response) => {
  json(response, { cancelled: jobs.cancel(request.params.id) });
});

app.get('/api/downloads/:id/events', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return json(response, { error: 'Unknown job' }, 404);

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);

  const listener = (updated: DownloadJob) => {
    if (updated.id !== request.params.id) return;
    response.write(`event: job\ndata: ${JSON.stringify(updated)}\n\n`);
    if (['done', 'failed', 'cancelled'].includes(updated.state)) {
      response.write('event: end\ndata: {}\n\n');
    }
  };
  jobs.on('update', listener);

  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000);
  request.on('close', () => {
    clearInterval(heartbeat);
    jobs.off('update', listener);
  });
});

/* ---------------------------------------------------------------- library --- */

app.get('/api/library', async (_request, response) => {
  json(response, { entries: await pruneLibrary() });
});

app.delete('/api/library/:id', async (request, response) => {
  json(response, { removed: await removeFromLibrary(request.params.id) });
});

app.get('/api/library/:id/file', async (request, response) => {
  const path = await libraryFilePath(request.params.id);
  if (!path || !existsSync(path)) return json(response, { error: 'File not found' }, 404);
  const info = await stat(path);
  response.setHeader('content-type', 'application/vnd.android.package-archive');
  response.setHeader('content-length', info.size);
  response.setHeader('content-disposition', `attachment; filename="${basename(path)}"`);
  response.sendFile(path);
});

app.get('/api/library/:id/inspect', async (request, response) => {
  const path = await libraryFilePath(request.params.id);
  if (!path || !existsSync(path)) return json(response, { error: 'File not found' }, 404);
  const file = await describeApk(path);
  const entries = await listLibrary();
  const entry = entries.find((item) => item.id === request.params.id);
  json(response, {
    file,
    entry,
  });
});

/* -------------------------------------------------------- manual verify/import --- */

app.post('/api/verify', express.raw({ type: '*/*', limit: '1024mb' }), async (request, response) => {
  try {
    const bytes = request.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('No file received');
    const fileName = String(request.query.name ?? 'upload.apk');
    const safeName = basename(fileName).replace(/[^\w.\-]+/g, '_');
    const target = join(dataDir, 'inbox', `${Date.now().toString(36)}-${safeName}`);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'inbox'), { recursive: true });
    await writeFile(target, bytes);

    const file = await describeApk(target);
    const packageName = String(request.query.packageName ?? file.packageName ?? '');
    const version = request.query.version ? String(request.query.version) : (file.versionName ?? null);
    const app = catalog().apps.find((entry) => entry.packageName === packageName);
    const target_ = app?.targets.find((entry) => entry.version === version) ?? null;

    const expected: ExpectedApp = {
      packageName,
      appName: app?.name ?? file.packageName ?? packageName,
      versionName: version,
      versionCodes: target_?.versionCodes ?? null,
      fileType: (app?.fileType ?? null) as ApkFileType | null,
      signatures: app?.signatures ?? [],
    };
    const verification = verifyApk(file, expected);

    let libraryEntry = null;
    if (request.query.keep === '1' && verification.status !== 'fail') {
      libraryEntry = await addToLibrary({
        file,
        verification,
        appName: app?.name ?? null,
        providerId: 'manual',
        sourceUrl: null,
        notes: 'Added manually',
      });
    } else {
      // Not kept: drop the temporary copy so the inbox does not grow forever.
      const { rm } = await import('node:fs/promises');
      await rm(target, { force: true }).catch(() => undefined);
    }

    json(response, { file, verification, libraryEntry });
  } catch (error) {
    fail(response, error);
  }
});

/* -------------------------------------------------------------------- misc --- */

app.use('/api', (_request, response) => {
  json(response, { error: 'Unknown API route' }, 404);
});

/* ------------------------------------------------------------------- front --- */

if (isDev) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(repoRoot, 'vite.config.ts'),
    // HMR would need a second port, which the hosted preview does not expose, so
    // the dev server reloads on navigation instead.
    server: { middlewareMode: true, hmr: false, allowedHosts: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distDir = join(repoRoot, 'dist', 'web');
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.use(async (request: Request, response: Response) => {
    if (request.path.startsWith('/api')) return json(response, { error: 'Unknown API route' }, 404);
    const indexHtml = join(distDir, 'index.html');
    if (!existsSync(indexHtml)) {
      response
        .status(503)
        .type('text/plain')
        .send('PatchPilot is not built yet. Run "npm run build" or start with "npm run dev".');
      return;
    }
    response.type('html').send(await readFile(indexHtml, 'utf8'));
  });
}

// Keep patch data fresh while the app is open, following the user's preference.
setInterval(
  () => {
    const minutes = settings.autoRefreshMinutes;
    if (offlineMode || !minutes || minutes <= 0) return;
    void registry.refresh().then(() => invalidateCatalog()).catch(() => undefined);
  },
  Math.max(5, settings.autoRefreshMinutes || 30) * 60_000,
).unref();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`PatchPilot listening on http://localhost:${port}`);
  console.log(`Library folder: ${libraryDir}`);
  console.log(`Bundles: ${registry.getInfos().map((bundle) => `${bundle.name} (${bundle.patchCount} patches, ${bundle.origin ?? 'unloaded'})`).join(', ')}`);
  if (demoSourceEnabled) console.log('Offline demo source enabled (PATCHPILOT_DEMO=1)');
  if (offlineMode) console.log('Offline mode: no network calls will be made (PATCHPILOT_OFFLINE=1)');
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
