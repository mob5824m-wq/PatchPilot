import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DownloadJob, Settings } from '../src/shared/types.ts';
import { testCertificateSha256 } from '../src/server/apk/fixture.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'patchpilot-jobs-'));
process.env.PATCHPILOT_DATA_DIR = dataDir;
process.env.PATCHPILOT_DEMO = '1';

const { JobManager } = await import('../src/server/jobs.ts');
const { ensureDirs, libraryDir } = await import('../src/server/config.ts');
const { listLibrary } = await import('../src/server/library.ts');

ensureDirs();

const settings: Settings = {
  providers: {},
  preferAbi: null,
  autoRefreshMinutes: 0,
  demoSource: true,
};

function waitFor(jobs: InstanceType<typeof JobManager>, id: string, timeoutMs = 15_000): Promise<DownloadJob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`job ${id} did not finish in time`)), timeoutMs);
    const check = () => {
      const job = jobs.get(id);
      if (job && ['done', 'failed', 'cancelled'].includes(job.state)) {
        clearTimeout(timer);
        resolve(job);
        return true;
      }
      return false;
    };
    if (check()) return;
    jobs.on('update', () => {
      check();
    });
  });
}

test('a job downloads, verifies and files the APK', async () => {
  const manager = new JobManager(async () => settings);
  const created = manager.create({
    packageName: 'com.example.demo',
    appName: 'Demo App',
    version: '2.3.4',
    versionCodes: { ARM64_V8A: 234 },
    fileType: 'APK_REQUIRED',
    signatures: [testCertificateSha256()],
    providers: ['demo'],
  });

  const job = await waitFor(manager, created.id);
  assert.equal(job.state, 'done', job.error ?? 'job failed');

  const result = job.result;
  assert.ok(result);
  assert.equal(result!.file.packageName, 'com.example.demo');
  assert.equal(result!.file.versionName, '2.3.4');
  // Fixtures are signed with PatchPilot's test key, so the certificate check is
  // reported as a warning rather than claiming the real developer signed it.
  assert.equal(result!.verification.status, 'warn');
  assert.ok(
    result!.verification.checks.some((check) => check.id === 'signature' && check.status === 'warn'),
  );
  assert.equal(result!.file.demo, true);

  // The file moved out of the temp dir into the library.
  const files = await readdir(libraryDir);
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('com.example.demo_2.3.4'));

  const entries = await listLibrary();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].demo, true);
  assert.equal(entries[0].verificationStatus, 'warn');
  assert.equal(entries[0].providerId, 'demo');
});

test('a source that hands back the wrong version is rejected, not saved', async () => {
  const { buildApk } = await import('../src/server/apk/fixture.ts');
  const { mkdtemp: makeTemp, writeFile } = await import('node:fs/promises');
  const workingDir = await makeTemp(join(tmpdir(), 'patchpilot-wrong-'));

  // A source that always answers with version 1.0.0, whatever was asked for.
  const wrongVersionProvider = {
    id: 'wrong',
    label: 'Wrong version source',
    description: 'test double',
    homepage: 'https://example.test',
    kind: 'file' as const,
    notes: [],
    resolve: async () => {
      const path = join(workingDir, 'wrong.apk');
      await writeFile(path, buildApk({ packageName: 'com.example.wrong', versionName: '1.0.0', versionCode: 100 }));
      return { files: [{ url: 'file://wrong', localPath: path, label: 'wrong build' }], pages: [], detail: 'served 1.0.0' };
    },
  };

  const manager = new JobManager(async () => settings, [wrongVersionProvider]);
  const created = manager.create({
    packageName: 'com.example.wrong',
    appName: 'Wrong App',
    version: '2.0.0',
    versionCodes: null,
    fileType: 'APK_REQUIRED',
    signatures: [],
  });

  const job = await waitFor(manager, created.id);
  assert.equal(job.state, 'failed');
  assert.match(job.error ?? '', /Version/);
  assert.ok(
    job.logs.some((line) => /rejected/i.test(line.message)),
    'the log should say the download was rejected',
  );

  // Nothing was filed in the library for this job.
  const entries = await listLibrary();
  assert.ok(!entries.some((entry) => entry.packageName === 'com.example.wrong'));
  await rm(workingDir, { recursive: true, force: true });
});

test('cancelling a queued job marks it cancelled', async () => {
  const manager = new JobManager(async () => settings);
  const created = manager.create({
    packageName: 'com.example.demo',
    appName: 'Demo App',
    version: '1.0.0',
    versionCodes: null,
    fileType: null,
    signatures: [],
    providers: ['demo'],
  });
  manager.cancel(created.id);
  const job = manager.get(created.id);
  assert.ok(job);
  assert.ok(['cancelled', 'done'].includes(job!.state));
});

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
