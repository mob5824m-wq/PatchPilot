import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApk, buildZip, loadTestKey, testCertificateSha256 } from '../src/server/apk/fixture.ts';
import { parseBinaryManifest } from '../src/server/apk/axml.ts';
import { readSigningCertificates } from '../src/server/apk/signblock.ts';
import { describeApk, verifyApk } from '../src/server/apk/verify.ts';
import { ZipReader } from '../src/server/apk/zip.ts';

const here = dirname(fileURLToPath(import.meta.url));
const helloActivity = join(here, '..', 'fixtures', 'apk', 'HelloActivity.apk');

async function tempApk(bytes: Buffer, name = 'app.apk'): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'patchpilot-test-'));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { dir, path };
}

test('reads a real APK manifest and fatals nowhere', async () => {
  const info = await describeApk(helloActivity);
  assert.equal(info.packageName, 'com.example.android.helloactivity');
  assert.equal(info.versionCode, 13);
  assert.equal(info.container, 'apk');
  assert.ok(info.sizeBytes > 0);
  // v1-only APK: no v2/v3 block, so no certificate digest.
  assert.deepEqual(info.signerSha256, []);
});

test('reads package, version and certificate digest from a v2-signed APK', async () => {
  const bytes = buildApk({ packageName: 'com.example.v2', versionName: '3.4.5', versionCode: 345, minSdk: 24, targetSdk: 33 });
  const { dir, path } = await tempApk(bytes);
  try {
    const info = await describeApk(path);
    assert.equal(info.packageName, 'com.example.v2');
    assert.equal(info.versionName, '3.4.5');
    assert.equal(info.versionCode, 345);
    assert.equal(info.minSdk, 24);
    assert.equal(info.targetSdk, 33);
    assert.deepEqual(info.signingSchemes, ['v2']);
    assert.deepEqual(info.signerSha256, [testCertificateSha256()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('certificate digest matches the DER certificate in the test key', async () => {
  const { certificateDer } = loadTestKey();
  const { createHash } = await import('node:crypto');
  assert.equal(testCertificateSha256(), createHash('sha256').update(certificateDer).digest('hex'));
});

test('verification passes for a matching APK and fails for a repack', async () => {
  const bytes = buildApk({ packageName: 'com.example.v2', versionName: '3.4.5', versionCode: 345 });
  const { dir, path } = await tempApk(bytes);
  try {
    const info = await describeApk(path);

    const good = verifyApk(info, {
      packageName: 'com.example.v2',
      versionName: '3.4.5',
      versionCodes: { ARM64_V8A: 345 },
      fileType: 'APK_REQUIRED',
      signatures: [testCertificateSha256()],
    });
    assert.equal(good.status, 'pass');
    assert.ok(good.checks.every((check) => check.status === 'pass'));

    const wrongVersion = verifyApk(info, { packageName: 'com.example.v2', versionName: '9.9.9' });
    assert.equal(wrongVersion.status, 'fail');
    assert.ok(wrongVersion.checks.some((check) => check.id === 'versionName' && check.status === 'fail'));

    const wrongPackage = verifyApk(info, { packageName: 'com.other.app' });
    assert.equal(wrongPackage.status, 'fail');

    const repack = verifyApk(info, {
      packageName: 'com.example.v2',
      versionName: '3.4.5',
      signatures: ['f'.repeat(64)],
    });
    assert.equal(repack.status, 'fail');
    assert.ok(repack.checks.some((check) => check.id === 'signature' && check.status === 'fail'));

    const wrongFileType = verifyApk(info, { packageName: 'com.example.v2', fileType: 'APKS_REQUIRED' });
    assert.equal(wrongFileType.status, 'fail');
    assert.ok(wrongFileType.checks.some((check) => check.id === 'fileType' && check.status === 'fail'));

    const versionCodeMismatch = verifyApk(info, {
      packageName: 'com.example.v2',
      versionName: '3.4.5',
      versionCodes: { ARM64_V8A: 999 },
    });
    assert.equal(versionCodeMismatch.status, 'fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('describes an .apkm style bundle from its base APK and metadata', async () => {
  const baseApk = buildApk({ packageName: 'com.example.bundle', versionName: '7.8.9', versionCode: 789 });
  const bundle = buildZip([
    {
      name: 'info.json',
      data: Buffer.from(JSON.stringify({ pname: 'com.example.bundle', versionname: '7.8.9', versioncode: 789 })),
    },
    { name: 'base.apk', data: baseApk },
    { name: 'split_config.arm64_v8a.apk', data: buildZip([{ name: 'dummy.txt', data: Buffer.from('x') }]) },
  ]);
  const { dir, path } = await tempApk(bundle, 'app.apkm');
  try {
    const info = await describeApk(path);
    assert.equal(info.container, 'apkm');
    assert.equal(info.packageName, 'com.example.bundle');
    assert.equal(info.versionName, '7.8.9');
    assert.equal(info.versionCode, 789);
    assert.equal(info.isSplit, true);
    assert.deepEqual(info.signerSha256, [testCertificateSha256()]);

    const result = verifyApk(info, { packageName: 'com.example.bundle', versionName: '7.8.9', fileType: 'APKS_REQUIRED' });
    assert.equal(result.status, 'pass');

    const needsApk = verifyApk(info, { packageName: 'com.example.bundle', fileType: 'APK_REQUIRED' });
    assert.equal(needsApk.status, 'fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zip reader lists entries and rejects non-zips', async () => {
  const bytes = buildApk({ packageName: 'com.example.zip', versionName: '1.0.0', versionCode: 1 });
  const { dir, path } = await tempApk(bytes);
  try {
    const reader = await ZipReader.open(path);
    const names = reader.entries.map((entry) => entry.name);
    assert.deepEqual(names, ['AndroidManifest.xml', 'classes.dex']);
    const manifest = await reader.read('AndroidManifest.xml');
    assert.ok(manifest.length > 0);
    await reader.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const notZip = await tempApk(Buffer.from('this is not a zip'));
  try {
    await assert.rejects(() => ZipReader.open(notZip.path), /Not a zip archive/);
  } finally {
    await rm(notZip.dir, { recursive: true, force: true });
  }
});

test('signing block reader returns nothing for an unsigned archive', async () => {
  const bytes = buildApk({ packageName: 'com.example.unsigned', versionName: '1.0.0', versionCode: 1, sign: false });
  const { dir, path } = await tempApk(bytes);
  try {
    assert.equal(await readSigningCertificates(path), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('binary manifest parser handles plain-text manifests too', () => {
  const info = parseBinaryManifest(
    Buffer.from('<manifest package="com.text.app" versionCode="42" versionName="4.2"><uses-sdk minSdkVersion="21"/></manifest>'),
  );
  assert.equal(info.plainText, true);
  assert.equal(info.packageName, 'com.text.app');
  assert.equal(info.versionCode, 42);
  assert.equal(info.versionName, '4.2');
  assert.equal(info.minSdk, 21);
});
