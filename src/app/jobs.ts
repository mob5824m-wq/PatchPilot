import type {
  ApkFileType,
  DownloadJob,
  JobLogLine,
  JobProviderAttempt,
  Settings,
} from '../shared/types.ts';
import { verifyApk, type ExpectedApp } from '../shared/verifyMeta.ts';
import type { CandidateFile, CandidatePage, Provider } from '../server/providers/types.ts';
import { toApkFileInfo, type LocalLibrary } from './library.ts';
import type { Native } from './native.ts';
import { activeAppProviders } from './providers.ts';

/**
 * The job runner on the phone: same strategy as the server's JobManager — ask
 * every source, download the most promising three links, verify, file it — with
 * the download and the APK reading delegated to Android.
 *
 * Verification itself is the shared, tested `verifyApk`, so a build that would
 * be rejected on a desktop is rejected here too.
 */

const MAX_CANDIDATES_PER_PROVIDER = 3;
const MAX_TOTAL_ATTEMPTS = 6;

export interface JobRequest {
  packageName: string;
  appName: string;
  version: string | null;
  versionCodes: Record<string, number> | null;
  fileType: ApkFileType | null;
  signatures: string[];
  providers?: string[] | null;
}

interface InternalJob extends DownloadJob {
  cancelled: boolean;
}

export class LocalJobs {
  private readonly jobs = new Map<string, InternalJob>();
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly native: Native,
    private readonly library: LocalLibrary,
    private readonly getSettings: () => Settings,
    private readonly onChange: (job: DownloadJob) => void,
  ) {}

  list(): DownloadJob[] {
    return [...this.jobs.values()].slice(-30).reverse().map((job) => this.snapshot(job));
  }

  get(id: string): DownloadJob | null {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (['done', 'failed', 'cancelled'].includes(job.state)) return false;
    job.cancelled = true;
    this.apply(job, (draft) => {
      draft.state = 'cancelled';
      draft.error = 'Cancelled';
      this.log(draft, 'warn', 'Job cancelled');
    });
    return true;
  }

  create(request: JobRequest): DownloadJob {
    this.counter += 1;
    const now = new Date().toISOString();
    const job: InternalJob = {
      id: `job-${Date.now().toString(36)}-${this.counter}`,
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
      cancelled: false,
    };

    this.jobs.set(job.id, job);
    this.log(job, 'info', `Looking for ${request.appName} ${request.version ?? ''} (${request.packageName})`);
    if (request.fileType) this.log(job, 'info', `Patches expect ${request.fileType}`);

    this.queue = this.queue.then(() => this.run(job)).catch(() => undefined);
    return this.snapshot(job);
  }

  /* ------------------------------------------------------------- internals --- */

  private snapshot(job: InternalJob): DownloadJob {
    const { cancelled, ...rest } = job;
    void cancelled;
    return structuredClone(rest);
  }

  private log(job: DownloadJob, level: JobLogLine['level'], message: string): void {
    job.logs.push({ at: new Date().toISOString(), level, message });
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  }

  private apply(job: InternalJob, mutate: (draft: DownloadJob) => void): void {
    mutate(job);
    job.updatedAt = new Date().toISOString();
    this.onChange(this.snapshot(job));
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
    const settings = this.getSettings();
    const providers = activeAppProviders(settings, job.request.providers);
    const expected: ExpectedApp = {
      packageName: job.request.packageName,
      appName: job.request.appName,
      versionName: job.request.version,
      versionCodes: job.request.versionCodes,
      fileType: job.request.fileType,
      signatures: job.request.signatures,
      preferAbi: settings.preferAbi,
    };

    if (!providers.length) {
      this.fail(job, 'No sources are enabled. Turn one on in the Sources tab.');
      return;
    }

    const pages: CandidatePage[] = [];
    const rejected: string[] = [];
    let attempts = 0;

    for (const provider of providers) {
      if (job.cancelled) return;
      const attempt = this.attempt(job, provider);
      attempt.status = 'trying';
      attempt.startedAt = new Date().toISOString();
      this.apply(job, (draft) => {
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
          log: (level, message) => this.apply(job, (draft) => this.log(draft, level, `${provider.label}: ${message}`)),
        });
      } catch (error) {
        attempt.status = 'failed';
        attempt.detail = (error as Error).message;
        attempt.finishedAt = new Date().toISOString();
        this.apply(job, (draft) => this.log(draft, 'warn', `${provider.label}: ${(error as Error).message}`));
        continue;
      }

      attempt.detail = result.detail;
      attempt.urls = result.files.map((file) => file.url).slice(0, 5);
      pages.push(...result.pages);
      this.apply(job, (draft) =>
        this.log(draft, result.files.length ? 'info' : 'warn', `${provider.label}: ${result.detail}`),
      );

      if (!result.files.length) {
        attempt.status = 'failed';
        attempt.finishedAt = new Date().toISOString();
        continue;
      }

      const candidates = result.files.slice(0, MAX_CANDIDATES_PER_PROVIDER);
      for (const candidate of candidates) {
        if (job.cancelled) return;
        if (attempts >= MAX_TOTAL_ATTEMPTS) {
          this.apply(job, (draft) => this.log(draft, 'warn', 'Stopping after too many download attempts'));
          break;
        }
        attempts += 1;
        const outcome = await this.tryCandidate(job, provider, candidate, expected);
        if (outcome.ok) {
          attempt.status = 'ok';
          attempt.finishedAt = new Date().toISOString();
          return;
        }
        rejected.push(`${provider.label}: ${outcome.reason ?? 'rejected'}`);
        this.apply(job, (draft) =>
          this.log(draft, 'warn', `${provider.label}: rejected ${candidate.label} — ${outcome.reason ?? 'did not verify'}`),
        );
      }
      attempt.status = 'failed';
      attempt.finishedAt = new Date().toISOString();
    }

    if (job.cancelled) return;
    if (pages.length) {
      job.attempts.push({
        providerId: 'manual',
        providerLabel: 'Open in browser',
        status: 'failed',
        detail: 'No source could hand back a file automatically. These pages have the build:',
        urls: pages.slice(0, 3).map((page) => page.url),
      });
    }
    this.fail(
      job,
      rejected.length
        ? `Every source was rejected: ${rejected.slice(0, 3).join(' · ')}`
        : 'No source could find that version. Try again, or download it by hand and use “Verify a file”.',
    );
  }

  private async tryCandidate(
    job: InternalJob,
    provider: Provider,
    candidate: CandidateFile,
    expected: ExpectedApp,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.apply(job, (draft) => {
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

    let download;
    try {
      download = await this.native.download(
        { url: candidate.url, fileName: candidate.label },
        (progress) =>
          this.apply(job, (draft) => {
            draft.progress.bytesReceived = progress.bytesReceived;
            draft.progress.bytesTotal = progress.bytesTotal;
          }),
      );
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }

    if (job.cancelled) {
      await this.native.deleteTemp(download.path).catch(() => undefined);
      return { ok: false, reason: 'cancelled' };
    }

    this.apply(job, (draft) => {
      draft.state = 'verifying';
      this.log(draft, 'info', `Downloaded ${Math.round(download.sizeBytes / 1024 / 1024)} MB, verifying…`);
    });

    let observed;
    try {
      observed = await this.native.inspect(download.path);
    } catch (error) {
      await this.native.deleteTemp(download.path).catch(() => undefined);
      return { ok: false, reason: `not a readable archive (${(error as Error).message})` };
    }

    const fileInfo = toApkFileInfo(observed, download.name, download.path);
    const verification = verifyApk(fileInfo, expected);

    for (const check of verification.checks) {
      if (check.status === 'pass') continue;
      this.apply(job, (draft) =>
        this.log(draft, check.status === 'fail' ? 'warn' : 'info', `${check.label}: ${check.detail}`),
      );
    }

    if (verification.status === 'fail') {
      await this.native.deleteTemp(download.path).catch(() => undefined);
      const failure = verification.checks.find((check) => check.status === 'fail');
      return { ok: false, reason: failure ? `${failure.label}: ${failure.detail}` : 'verification failed' };
    }

    const entry = await this.library.add({
      file: fileInfo,
      tempPath: download.path,
      verification,
      appName: job.request.appName,
      providerId: provider.id,
      sourceUrl: candidate.url,
      notes: null,
    });

    this.apply(job, (draft) => {
      draft.state = 'done';
      draft.result = { libraryId: entry.id, file: fileInfo, verification };
      draft.progress.bytesReceived = download.sizeBytes;
      draft.progress.bytesTotal = download.sizeBytes;
      this.log(draft, 'success', `Saved ${entry.fileName} to Downloads/PatchPilot — ${verification.summary}`);
    });

    return { ok: true };
  }

  private fail(job: InternalJob, message: string): void {
    this.apply(job, (draft) => {
      draft.state = 'failed';
      draft.error = message;
      this.log(draft, 'error', message);
    });
  }
}
