import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BundleInfo } from '../src/shared/types.ts';
import { parsePatchList } from '../src/server/bundles/parse.ts';
import { buildAppDetail, buildCatalog } from '../src/server/catalog.ts';

function bundleInfo(id: string, name = id): BundleInfo {
  return {
    id,
    name,
    kind: 'github',
    enabled: true,
    builtin: false,
    version: '1.0.0',
    patchCount: 0,
    packageCount: 0,
    fetchedAt: null,
    origin: 'seed',
    stale: false,
    error: null,
    downloadUrl: null,
  };
}

function payload(id: string, list: unknown) {
  return { info: bundleInfo(id), patches: parsePatchList(list, id).patches };
}

const youtube = {
  version: '2.0.0',
  patches: [
    {
      name: 'Hide ads',
      description: 'Removes ads',
      default: true,
      compatiblePackages: [
        {
          packageName: 'com.google.android.youtube',
          name: 'YouTube',
          apkFileType: 'APK_REQUIRED',
          appIconColor: '#FF0033',
          signatures: ['AAA'],
          formFactor: 'MOBILE',
          targets: [
            { version: '21.43.523', isExperimental: true, minSdk: 29 },
            { version: '21.30.216', isExperimental: false, minSdk: 28 },
            { version: '21.9.7', isExperimental: false, minSdk: 28 },
          ],
        },
      ],
    },
    {
      name: 'SponsorBlock',
      description: 'Skips sponsors',
      default: true,
      compatiblePackages: [
        {
          packageName: 'com.google.android.youtube',
          name: 'YouTube',
          apkFileType: 'APK_REQUIRED',
          appIconColor: '#FF0033',
          signatures: ['AAA', 'BBB'],
          targets: [{ version: '21.30.216', isExperimental: false, minSdk: 28 }],
        },
      ],
    },
  ],
};

test('recommends the newest stable version, not the newest experimental one', () => {
  const catalog = buildCatalog([payload('official', youtube)]);
  const app = catalog.apps[0];
  assert.equal(app.latestVersion, '21.43.523');
  assert.equal(app.latestStableVersion, '21.30.216');
  assert.equal(app.recommendedVersion, '21.30.216');
  assert.equal(app.experimentalOnly, false);
  assert.equal(app.patchCount, 2);
});

test('merges patch support per version', () => {
  const catalog = buildCatalog([payload('official', youtube)]);
  const app = catalog.apps[0];
  const newestStable = app.targets.find((target) => target.version === '21.30.216');
  assert.equal(newestStable?.patchCount, 2);
  const experimental = app.targets.find((target) => target.version === '21.43.523');
  assert.equal(experimental?.patchCount, 1);
  assert.equal(experimental?.isExperimental, true);
  assert.deepEqual(newestStable?.patches, ['Hide ads', 'SponsorBlock']);
});

test('merges the same app across bundles and unions signatures', () => {
  const second = {
    patches: [
      {
        name: 'Theme',
        description: 'AMOLED',
        default: true,
        compatiblePackages: [
          {
            packageName: 'com.google.android.youtube',
            name: 'YouTube',
            apkFileType: 'APK_REQUIRED',
            signatures: ['CCC'],
            targets: [{ version: '21.30.216' }],
          },
        ],
      },
    ],
  };
  const catalog = buildCatalog([payload('official', youtube), payload('extra', second)]);
  const app = catalog.apps[0];
  assert.equal(app.patchCount, 3);
  assert.deepEqual(app.signatures.sort(), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(app.bundles.map((bundle) => bundle.id).sort(), ['extra', 'official']);
});

test('an app whose only targets are experimental is flagged as such', () => {
  const catalog = buildCatalog([
    payload('dev', {
      patches: [
        {
          name: 'Only dev',
          compatiblePackages: [
            { packageName: 'com.example.app', name: 'Example', targets: [{ version: '1.0.0', isExperimental: true }] },
          ],
        },
      ],
    }),
  ]);
  const app = catalog.apps[0];
  assert.equal(app.experimentalOnly, true);
  assert.equal(app.recommendedVersion, '1.0.0');
  assert.equal(app.latestStableVersion, null);
});

test('universal patches are not attributed to any app', () => {
  const catalog = buildCatalog([
    payload('b', { patches: [{ name: 'Universal', compatiblePackages: null }] }),
  ]);
  assert.equal(catalog.apps.length, 0);
  assert.equal(catalog.patchCount, 1);
});

test('picks the strictest declared file type', () => {
  const catalog = buildCatalog([
    payload('b', {
      patches: [
        {
          name: 'Needs splits',
          compatiblePackages: [
            {
              packageName: 'com.reddit.frontpage',
              apkFileType: 'APKS_REQUIRED',
              targets: [{ version: '2026.10.0' }],
            },
          ],
        },
        {
          name: 'Looser',
          compatiblePackages: [{ packageName: 'com.reddit.frontpage', apkFileType: 'APK', targets: [{ version: '2026.10.0' }] }],
        },
      ],
    }),
  ]);
  assert.equal(catalog.apps[0].fileType, 'APKS_REQUIRED');
  assert.deepEqual(catalog.apps[0].fileTypes.sort(), ['APK', 'APKS_REQUIRED']);
});

test('app detail lists patches with their versions', () => {
  const detail = buildAppDetail([payload('official', youtube)], 'com.google.android.youtube');
  assert.ok(detail);
  const sponsor = detail.patches.find((patch) => patch.name === 'SponsorBlock');
  assert.deepEqual(sponsor?.versions, ['21.30.216']);
  assert.equal(detail.recommendedVersion, '21.30.216');
});
