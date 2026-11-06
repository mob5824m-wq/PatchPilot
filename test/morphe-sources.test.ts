import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBundleSource, parseBundleSources } from '../src/shared/bundleSource.ts';
import { importBundleSources, type ImportableBundle } from '../src/shared/bundleImport.ts';
import { buildCatalog } from '../src/core/catalog.ts';
import { defaultBundles } from '../src/shared/defaults.ts';
import type { Patch } from '../src/core/bundles/types.ts';

function patch(bundleId: string, packageName: string, versions: string[]): Patch {
  return {
    name: `patch-${packageName}`,
    description: 'test patch',
    isDefault: true,
    category: null,
    bundleId,
    legacyUniversal: false,
    compatibility: [
      {
        packageName,
        appName: packageName,
        description: null,
        fileType: 'APK',
        iconColor: null,
        formFactor: 'MOBILE',
        signatures: [],
        targets: versions.map((version) => ({
          version,
          versionCodes: null,
          isExperimental: false,
          minSdk: null,
          description: null,
        })),
      },
    ],
  };
}

test('a pasted source list survives the shapes Morphe prints', () => {
  assert.deepEqual(parseBundleSource('MorpheApp/morphe-patches'), { kind: 'github', value: 'MorpheApp/morphe-patches' });
  assert.deepEqual(parseBundleSource('https://github.com/hxreborn/morphe-patches'), {
    kind: 'github',
    value: 'hxreborn/morphe-patches',
  });
  assert.deepEqual(parseBundleSource('https://github.com/crimera/piko.git'), { kind: 'github', value: 'crimera/piko' });
  assert.deepEqual(parseBundleSource('  - `MorpheApp/morphe-patches`  '), {
    kind: 'github',
    value: 'MorpheApp/morphe-patches',
  });
  assert.deepEqual(parseBundleSource('Morphe Patches'), { kind: 'name', value: 'Morphe Patches' });
  assert.equal(parseBundleSource(''), null);
  assert.equal(parseBundleSource('# my sources'), null);
  const file = parseBundleSource('patches.json');
  assert.ok(file && 'error' in file);
  assert.match((file as { error: string }).error, /file name, not a bundle source/);
});

test('a bundle file link is refused instead of half-imported', () => {
  const parsed = parseBundleSource('https://example.com/morphe-patches.mpp');
  assert.ok(parsed && 'error' in parsed);
  assert.match((parsed as { error: string }).error, /Load a \.mpp file/);
});

test('repeated lines are dropped, unusable ones are reported', () => {
  const parsed = parseBundleSources(`
    MorpheApp/morphe-patches
    https://github.com/MorpheApp/morphe-patches
    hxreborn/morphe-patches
    https://example.com/x.mpp
  `);

  assert.deepEqual(
    parsed.entries.map((entry) => entry.value),
    ['MorpheApp/morphe-patches', 'hxreborn/morphe-patches'],
  );
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0]!.reason, /\.mpp file/);
});

test('importing switches on known bundles and adds unknown ones', async () => {
  const state: ImportableBundle[] = [
    { id: 'morphe-official', name: 'Morphe Patches', repo: 'MorpheApp/morphe-patches', enabled: false },
    { id: 'piko', name: 'Piko', repo: 'crimera/piko', enabled: true },
  ];
  const added: string[] = [];
  const enabled: string[] = [];

  const outcome = await importBundleSources(
    ['MORPHEAPP/MORPHE-PATCHES', 'someone/other-patches', 'Piko', 'Nope Not Loaded', 'https://example.com/x.mpp'].join('\n'),
    {
      configs: () => state,
      enable: async (id) => {
        enabled.push(id);
        const match = state.find((entry) => entry.id === id);
        if (match) match.enabled = true;
      },
      add: async (repo) => {
        added.push(repo);
        state.push({ id: repo.replace('/', '-'), name: repo, repo, enabled: true });
      },
    },
  );

  // Already on: nothing to do. Off but known: switched on. Unknown repo: added.
  assert.deepEqual(enabled, ['morphe-official']);
  assert.deepEqual(added, ['someone/other-patches']);
  assert.deepEqual(outcome.enabled, ['Morphe Patches']);
  assert.deepEqual(outcome.added, ['someone/other-patches']);
  // Lines that parse but name nothing known come back in the order they were read.
  assert.deepEqual(
    outcome.skipped.map((entry) => entry.source),
    ['https://example.com/x.mpp', 'Nope Not Loaded'],
  );
});

test('no Morphe bundles are shipped switched on', () => {
  assert.equal(defaultBundles.length, 3);
  assert.deepEqual(
    defaultBundles.filter((bundle) => bundle.enabled),
    [],
    'a bundle only counts once the user says their Morphe has it',
  );
});

test('the catalog contains only the bundles that are loaded', () => {
  const viaBundle = (id: string, name: string) => ({
    info: {
      id,
      name,
      kind: 'github' as const,
      enabled: true,
      builtin: true,
      version: '1.0.0',
      patchCount: 1,
      packageCount: 1,
      fetchedAt: new Date().toISOString(),
      origin: 'network' as const,
      stale: false,
      error: null,
      downloadUrl: null,
    },
    patches: [patch(id, id === 'a' ? 'com.example.a' : 'com.example.b', ['1.0.0'])],
  });

  const only = buildCatalog([viaBundle('a', 'Bundle A')]);
  assert.deepEqual(
    only.apps.map((app) => app.packageName),
    ['com.example.a'],
  );
  assert.deepEqual(only.morphe, { loaded: 1, available: 1 });

  const none = buildCatalog([]);
  assert.equal(none.appCount, 0);
  assert.deepEqual(none.morphe, { loaded: 0, available: 0 });

  const both = buildCatalog([viaBundle('a', 'Bundle A'), viaBundle('b', 'Bundle B')]);
  assert.equal(both.appCount, 2);
  assert.equal(both.morphe.loaded, 2);
});
