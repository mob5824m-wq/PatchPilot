import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'patchpilot-registry-'));
process.env.PATCHPILOT_DATA_DIR = dataDir;
process.env.PATCHPILOT_OFFLINE = '1';

const { BundleRegistry } = await import('../src/server/bundles/registry.ts');
const { buildCatalog } = await import('../src/server/catalog.ts');
const { ensureDirs } = await import('../src/server/config.ts');

test('offline mode serves the bundled snapshots', async () => {
  ensureDirs();
  const registry = new BundleRegistry();
  await registry.init();

  const infos = registry.getInfos();
  assert.ok(infos.length >= 3);
  const official = infos.find((info) => info.id === 'morphe-official');
  assert.ok(official);
  assert.equal(official?.origin, 'seed');
  assert.ok((official?.patchCount ?? 0) > 100);

  const catalog = buildCatalog(registry.getPayloads());
  assert.ok(catalog.appCount > 100, `expected a large catalog, got ${catalog.appCount}`);
  const youtube = catalog.apps.find((app) => app.packageName === 'com.google.android.youtube');
  assert.ok(youtube, 'YouTube should be in the catalog');
  assert.ok(youtube!.targets.length >= 5);
  assert.ok(youtube!.recommendedVersion);
  assert.ok(youtube!.signatures.length > 0);
  assert.equal(youtube!.fileType, 'APK_REQUIRED');
});

test('bundles can be disabled without removing them', async () => {
  const registry = new BundleRegistry();
  await registry.init();
  await registry.setEnabled('piko', false);
  const enabled = registry.getPayloads().map((payload) => payload.info.id);
  assert.ok(!enabled.includes('piko'));

  await registry.setEnabled('piko', true);
  const reenabled = registry.getPayloads().map((payload) => payload.info.id);
  assert.ok(reenabled.includes('piko'));
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
