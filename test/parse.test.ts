import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBundleInfo, parsePatchList } from '../src/server/bundles/parse.ts';

const modernBundle = {
  NOTE: 'generated',
  version: '2.0.0',
  patches: [
    {
      name: 'Hide ads',
      description: 'Removes ads.',
      default: true,
      category: null,
      compatiblePackages: [
        {
          packageName: 'com.google.android.youtube',
          name: 'YouTube',
          apkFileType: 'APK_REQUIRED',
          appIconColor: '#FF0033',
          signatures: ['abc123'],
          formFactor: 'MOBILE',
          targets: [
            { version: '21.43.523', versionCodes: null, isExperimental: true, minSdk: 29 },
            { version: '21.30.216', versionCodes: { ARM64_V8A: 1834567 }, isExperimental: false, minSdk: 28 },
          ],
        },
      ],
      options: [],
    },
  ],
};

test('parses the modern compatiblePackages array', () => {
  const parsed = parsePatchList(modernBundle, 'official');
  assert.equal(parsed.version, '2.0.0');
  assert.equal(parsed.patches.length, 1);

  const patch = parsed.patches[0];
  assert.equal(patch.name, 'Hide ads');
  assert.equal(patch.isDefault, true);
  assert.equal(patch.bundleId, 'official');
  assert.equal(patch.compatibility.length, 1);

  const compatibility = patch.compatibility[0];
  assert.equal(compatibility.packageName, 'com.google.android.youtube');
  assert.equal(compatibility.appName, 'YouTube');
  assert.equal(compatibility.fileType, 'APK_REQUIRED');
  assert.deepEqual(compatibility.signatures, ['abc123']);
  assert.equal(compatibility.targets.length, 2);
  assert.equal(compatibility.targets[0].isExperimental, true);
  assert.deepEqual(compatibility.targets[1].versionCodes, { ARM64_V8A: 1834567 });
});

test('parses the legacy package map format', () => {
  const legacy = {
    patches: [
      {
        name: 'Enable AI tools',
        description: '...',
        use: true,
        compatiblePackages: {
          'com.google.android.inputmethod.latin': ['18.5.4.993608717-release-arm64-v8a'],
        },
        options: [],
      },
    ],
  };
  const parsed = parsePatchList(legacy, 'gboard');
  const patch = parsed.patches[0];
  assert.equal(patch.isDefault, true);
  assert.equal(patch.compatibility[0].packageName, 'com.google.android.inputmethod.latin');
  assert.deepEqual(
    patch.compatibility[0].targets.map((target) => target.version),
    ['18.5.4.993608717-release-arm64-v8a'],
  );
  // The legacy format carries no file type or signatures, so nothing is invented.
  assert.equal(patch.compatibility[0].fileType, null);
  assert.deepEqual(patch.compatibility[0].signatures, []);
});

test('marks patches without packages as universal', () => {
  const parsed = parsePatchList({ patches: [{ name: 'Spoof signature', compatiblePackages: null }] }, 'b');
  assert.equal(parsed.patches[0].legacyUniversal, true);
  assert.equal(parsed.patches[0].compatibility.length, 0);
});

test('skips malformed entries with a warning instead of failing', () => {
  const parsed = parsePatchList(
    {
      patches: [
        { description: 'no name' },
        { name: 'Fine', compatiblePackages: [{ targets: [] }] },
      ],
    },
    'b',
  );
  // The nameless patch is dropped; the named one survives even though its
  // compatibility entry is unusable.
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].name, 'Fine');
  assert.ok(parsed.warnings.some((warning) => warning.includes('no name')));
  assert.ok(parsed.warnings.some((warning) => warning.includes('without a package name')));
});

test('rejects documents that are not patch lists', () => {
  const parsed = parsePatchList({ hello: 'world' }, 'b');
  assert.equal(parsed.patches.length, 0);
  assert.ok(parsed.warnings[0].includes('patches'));
});

test('reads bundle metadata', () => {
  const meta = parseBundleInfo({
    version: '1.71.0',
    download_url: 'https://example.test/patches.mpp',
    created_at: '2026-11-01T00:00:00Z',
  });
  assert.deepEqual(meta, {
    version: '1.71.0',
    downloadUrl: 'https://example.test/patches.mpp',
    createdAt: '2026-11-01T00:00:00Z',
  });
});
