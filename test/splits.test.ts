import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApkFileInfo } from '../src/shared/types.ts';
import { verifyApk, type ExpectedApp } from '../src/shared/verifyMeta.ts';

/**
 * The split-set checks: a bundle is only usable if it has a base APK, and only
 * good if it carries a split for the ABI the device (or the bundle) cares about.
 */

const APP = 'com.google.android.youtube';

function bundle(overrides: Partial<ApkFileInfo> = {}): ApkFileInfo {
  return {
    path: '/tmp/youtube.apkm',
    fileName: 'youtube.apkm',
    sizeBytes: 90_000_000,
    sha256: null,
    container: 'apkm',
    packageName: APP,
    versionName: '21.43.523',
    versionCode: 1834500,
    minSdk: 26,
    targetSdk: 34,
    isSplit: true,
    signerSha256: ['aa'],
    signingSchemes: ['v2'],
    metadataSource: 'bundle-info',
    splits: ['base.apk', 'split_config.arm64_v8a.apk', 'split_config.xxhdpi.apk'],
    warnings: [],
    ...overrides,
  };
}

const expected: ExpectedApp = {
  packageName: APP,
  appName: 'YouTube',
  versionName: '21.43.523',
  versionCodes: { ARM64_V8A: 1834500 },
  fileType: 'APKS_REQUIRED',
  signatures: ['aa'],
};

function check(file: ApkFileInfo, expectation: ExpectedApp = expected) {
  return verifyApk(file, expectation).checks.find((entry) => entry.id === 'splits');
}

test('a bundle with a base APK and the right ABI split passes', () => {
  const result = check(bundle());
  assert.equal(result?.status, 'pass');
  assert.match(result?.detail ?? '', /arm64_v8a/);
});

test('a bundle without base.apk is rejected outright', () => {
  const file = bundle({ splits: ['split_config.arm64_v8a.apk'] });
  const result = check(file);
  assert.equal(result?.status, 'fail');
  assert.equal(verifyApk(file, expected).status, 'fail');
});

test('a bundle missing the device ABI is a warning, not a rejection', () => {
  const file = bundle({ splits: ['base.apk', 'split_config.x86.apk'] });
  const result = check(file);
  assert.equal(result?.status, 'warn');
  assert.match(result?.detail ?? '', /No arm64_v8a split/);
  assert.equal(verifyApk(file, expected).status, 'warn');
});

test('the device ABI is used when the bundle does not pin one', () => {
  const file = bundle({ splits: ['base.apk', 'split_config.armeabi_v7a.apk'] });
  const result = check(file, { ...expected, versionCodes: null, preferAbi: 'armeabi-v7a' });
  assert.equal(result?.status, 'pass');

  const other = check(bundle({ splits: ['base.apk', 'split_config.arm64_v8a.apk'] }), {
    ...expected,
    versionCodes: null,
    preferAbi: 'armeabi-v7a',
  });
  assert.equal(other?.status, 'warn');
});

test('a bundle whose contents were never listed is skipped, not guessed at', () => {
  const result = check(bundle({ splits: undefined }));
  assert.equal(result?.status, 'skip');
});

test('a plain APK gets no split check at all', () => {
  const file = bundle({ container: 'apk', isSplit: false, splits: undefined, fileName: 'youtube.apk' });
  assert.equal(check(file), undefined);
});
