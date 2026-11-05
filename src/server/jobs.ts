import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApkFileType,
  DownloadJob,
  JobLogLine,
  JobProviderAttempt,
  Settings,
} from '../shared/types.ts';
import { describeApk, verifyApk, type ExpectedApp } from './apk/verify.ts';
import { downloadCandidate } from './downloader.ts';
import { addToLibrary } from './library.ts';
import { activeProviders } from './providers/index.ts';
import type { CandidateFile, CandidatePage, Provider } from './providers/types.ts';

/**
 * Runs one acquisition job: ask each enabled source where the required build
 * lives, download what they hand back, verify it against the patch bundle, and
 * only then file it in the library.
 *
 * A job is a small state machine whose whole state is pushed to the UI, so the
 * log the user sees is the real reason a source failed — not "something went
 * wrong".
 */

/** Guard rails so one job cannot spend forever on a mirror with a thousand links. */
const MAX_CANDIDATES_PER_PROVIDER = 3;
const MAX_TOTAL_ATTEMPTS = 8;

export interface JobRequest {
  packageName: string;
  appName: string;
  version: string | null;
  versionCodes: Record<string, number> | null;
  fileType: ApkFileType | null;
  signatures: string[];
  /** Optional allow-list of provider ids. */
  providers?: string[] | null;
}

interface InternalJob extends DownloadJob {
  controller: AbortController;
}

export class JobManager extends EventEmitter {
  private readonly jobs = new Map<string, InternalJob>();
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;

  /** `providerOverride` lets tests inject sources instead of using the registry. */
  constructor(
    private readonly getSettings: () => Promise<Settings>,
    private readonly providerOverride: Provider[] | null = null,
  ) {
    super();
    this.setMaxListeners(50);
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()]
      .slice(-40)
      .reverse()
      .map(({ controller, ...job }) => structuredClone(job));
  }

  get(id: string): DownloadJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const { controller, ...rest } = job;
    void controller;
    return structuredClone(rest);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (['done', 'failed', 'cancelled'].includes(job.state)) return false;
    job.controller.abort();
    this.update(job, (draft) => {
      draft.state = 'cancelled';
      draft.error = 'Cancelled by user';
      this.log(draft, 'warn', 'Job cancelled');
    });
    return true;
  }

  create(request: JobRequest): DownloadJob {
    this.counter += 1;
    const id = `job-${Date.now().toString(36)}-${this.counter}`;
    const now = new Date().toISOString();
    const job: InternalJob = {
      id,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      request: {
        packageName: request.packageName,
        appName: request.appName,
        version: request.version,
        versionCodes: request.versionCodes,
        fileType: request.fileType,
        signatures: request.signatures,
        providers: request.providers ?? null,
      },
      attempts: [],
      progress: { bytesReceived: 0, bytesTotal: null, fileName: null, url: null, providerId: null },
      logs: [],
      error: null,
      result: null,
      controller: new AbortController(),
    };

    this.jobs.set(id, job);
    this.log(job, 'info', `Looking for ${request.appName} ${request.version ?? ''} (${request.packageName})`);
    if (request.fileType) this.log(job, 'info', `Patches expect ${request.fileType}`);
    this.pruneOldJobs();

    // Serialise actual network work so parallel clicks do not hammer mirrors.
    this.queue = this.queue.then(() => this.run(job)).catch(() => undefined);
    return this.get(id)!;
  }

  private pruneOldJobs(): void {
    if (this.jobs.size <= 40) return;
    const finished = [...this.jobs.values()].filter((job) => ['done', 'failed', 'cancelled'].includes(job.state));
    for (const job of finished.slice(0, this.jobs.size - 40)) this.jobs.delete(job.id);
  }

  private log(job: DownloadJob, level: JobLogLine['level'], message: string): void {
    job.logs.push({ at: new Date().toISOString(), level, message });
    if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  }

  private update(job: InternalJob, mutate: (draft: DownloadJob) => void): void {
    mutate(job);
    job.updatedAt = new Date().toISOString();
    const { controller, ...rest } = job;
    void controller;
    this.emit('update', structuredClone(rest));
  }

  private attempt(job: InternalJob, provider: Provider): JobProviderAttempt {
    const existing = job.attempts.find((entry) => entry.providerId === provider.id);
    if (existing) return existing;
    const attempt: JobProviderAttempt = {
      providerId: provider.id,
      providerLabel: provider.label,
      status: 'pending',
      detail: '',
      urls: [],
    };
    job.attempts.push(attempt);
    return attempt;
  }

  private async run(job: InternalJob): Promise<void> {
    const settings = await this.getSettings();
    const providers = this.providerOverride
      ? this.providerOverride.filter(
          (provider) => !job.request.providers?.length || job.request.providers.includes(provider.id),
        )
      : activeProviders(settings, job.request.providers);
    const expected: ExpectedApp = {
      packageName: job.request.packageName,
      appName: job.request.appName,
      versionName: job.request.version,
      versionCodes: job.request.versionCodes,
      fileType: job.request.fileType,
      signatures: job.request.signatures,
    };

    if (!providers.length) {
      this.fail(job, 'No sources are enabled. Turn one on in the Sources tab.');
      return;
    }

    const pages: CandidatePage[] = [];
    const rejected: string[] = [];
    let workDir: string | null = null;
    let attempts = 0;

    try {
      for (const provider of providers) {
        if (job.controller.signal.aborted) return;
        const attempt = this.attempt(job, provider);
        attempt.status = 'trying';
        attempt.startedAt = new Date().toISOString();
        this.update(job, (draft) => {
          draft.state = 'resolving';
          draft.progress.providerId = provider.id;
        });

        let result;
        try {
          result = await provider.resolve({
            packageName: job.request.packageName,
            appName: job.request.appName,
            versionName: job.request.version,
            versionCodes: job.request.versionCodes,
            fileType: job.request.fileType,
            preferAbi: settings.preferAbi,
            log: (level, message) => this.update(job, (draft) => this.log(draft, level, `${provider.label}: ${message}`)),
          });
        } catch (error) {
          attempt.status = 'failed';
          attempt.detail = (error as Error).message;
          attempt.finishedAt = new Date().toISOString();
          this.update(job, (draft) => this.log(draft, 'warn', `${provider.label}: ${(error as Error).message}`));
          continue;
        }

        attempt.detail = result.detail;
        attempt.urls = result.files.map((file) => file.url).slice(0, 5);
        pages.push(...result.pages);
        this.update(job, (draft) => this.log(draft, result.files.length ? 'info' : 'warn', `${provider.label}: ${result.detail}`));

        if (!result.files.length) {
          attempt.status = 'failed';
          attempt.finishedAt = new Date().toISOString();
          continue;
        }

        const candidates = result.files.slice(0, MAX_CANDIDATES_PER_PROVIDER);
        if (result.files.length > candidates.length) {
          this.update(job, (draft) =>
            this.log(draft, 'info', `${provider.label}: trying the ${candidates.length} most promising of ${result.files.length} link(s)`),
          );
        }

        for (const candidate of candidates) {
          if (job.controller.signal.aborted) return;
          if (attempts >= MAX_TOTAL_ATTEMPTS) {
            this.update(job, (draft) => this.log(draft, 'warn', 'Stopping after too many download attempts'));
            break;
          }
          attempts += 1;
          const outcome = await this.tryCandidate(job, provider, attempt, candidate, expected, workDir);
          if (outcome.workDir) workDir = outcome.workDir;
          if (outcome.ok) {
            attempt.status = 'ok';
            attempt.finishedAt = new Date().toISOString();
            return;
          }
          rejected.push(`${provider.label}: ${outcome.reason ?? 'rejected'}`);
          this.update(job, (draft) =>
            this.log(draft, 'warn', `${provider.label}: rejected ${candidate.label} — ${outcome.reason ?? 'did not verify'}`),
          );
        }
        attempt.status = 'failed';
        attempt.finishedAt = new Date().toISOString();
      }

      const pageHint = pages.slice(0, 3).map((page) => page.url);
      if (pageHint.length) {
        job.attempts.push({
          providerId: 'manual',
          providerLabel: 'Open in browser',
          status: 'failed',
          detail: 'No source could hand back a file automatically. These pages have the build:',
          urls: pageHint,
        });
      }
      this.fail(
        job,
        rejected.length
          ? `Every source was rejected: ${rejected.slice(0, 3).join(' · ')}`
          : 'No source could find that version. Open one of the suggested pages in a browser, then add the file with “Verify a file”.',
      );
    } catch (error) {
      this.fail(job, (error as Error).message);
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async tryCandidate(
    job: InternalJob,
    provider: Provider,
    attempt: JobProviderAttempt,
    candidate: CandidateFile,
    expected: ExpectedApp,
    existingWorkDir: string | null,
  ): Promise<{ ok: boolean; reason?: string; workDir: string | null }> {
    let workDir = existingWorkDir;
    if (!workDir) workDir = await mkdtemp(join(tmpdir(), 'patchpilot-job-'));

    this.update(job, (draft) => {
      draft.state = 'downloading';
      draft.progress = {
        bytesReceived: 0,
        bytesTotal: null,
        fileName: candidate.label,
        url: candidate.url,
        providerId: provider.id,
      };
      this.log(draft, 'info', `Downloading ${candidate.label}`);
    });

    let outcome;
    try {
      outcome = await downloadCandidate(candidate, workDir, {
        signal: job.controller.signal,
        onProgress: (progress) =>
          this.update(job, (draft) => {
            draft.progress.bytesReceived = progress.bytesReceived;
            draft.progress.bytesTotal = progress.bytesTotal;
          }),
      });
    } catch (error) {
      if (job.controller.signal.aborted) {
        this.update(job, (draft) => {
          draft.state = 'cancelled';
        });
      }
      return { ok: false, reason: (error as Error).message, workDir };
    }

    this.update(job, (draft) => {
      draft.state = 'verifying';
      this.log(draft, 'info', `Downloaded ${Math.round(outcome.bytes / 1024 / 1024)} MB, verifying…`);
    });

    let fileInfo;
    try {
      fileInfo = await describeApk(outcome.path);
    } catch (error) {
      return { ok: false, reason: `not a readable archive (${(error as Error).message})`, workDir };
    }

    if (provider.id === 'demo') fileInfo.demo = true;

    const verification = verifyApk(fileInfo, expected);

    for (const check of verification.checks) {
      if (check.status === 'pass') continue;
      this.update(job, (draft) =>
        this.log(draft, check.status === 'fail' ? 'warn' : 'info', `${check.label}: ${check.detail}`),
      );
    }

    if (verification.status === 'fail') {
      await rm(outcome.path, { force: true }).catch(() => undefined);
      const failure = verification.checks.find((check) => check.status === 'fail');
      return { ok: false, reason: failure ? `${failure.label}: ${failure.detail}` : 'verification failed', workDir };
    }

    const entry = await addToLibrary({
      file: fileInfo,
      verification,
      appName: job.request.appName,
      providerId: provider.id,
      sourceUrl: candidate.url,
      notes: provider.id === 'demo' ? 'Offline demo fixture, not a real app' : null,
    });

    this.update(job, (draft) => {
      draft.state = 'done';
      draft.result = { libraryId: entry.id, file: fileInfo!, verification };
      draft.progress.bytesReceived = outcome.bytes;
      draft.progress.bytesTotal = outcome.bytes;
      attempt.status = 'ok';
      this.log(draft, 'success', `Saved ${entry.fileName} to the library — ${verification.summary}`);
    });

    return { ok: true, workDir };
  }

  private fail(job: InternalJob, message: string): void {
    this.update(job, (draft) => {
      draft.state = 'failed';
      draft.error = message;
      this.log(draft, 'error', message);
    });
  }
}
