import { useEffect, useRef, type ReactNode } from 'react';
import type { DownloadJob } from '../../shared/types.ts';
import { libraryFileUrl } from '../api.ts';
import { bytes, stateLabel } from '../format.ts';
import { Badge, Card, ProgressBar, Spinner, StatusDot } from './ui.tsx';

const ATTEMPT_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  pending: 'neutral',
  trying: 'info',
  ok: 'good',
  failed: 'bad',
  skipped: 'neutral',
};

export function JobPanel({
  job,
  onCancel,
  onDismiss,
}: {
  job: DownloadJob;
  onCancel: () => void;
  onDismiss: () => void;
}): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);
  const running = !['done', 'failed', 'cancelled'].includes(job.state);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.logs.length]);

  const verification = job.result?.verification ?? null;

  return (
    <Card className={`job-panel job-${job.state}`}>
      <div className="card-head">
        <h2>
          {running ? <Spinner /> : null} {stateLabel(job.state)} · {job.request.appName}{' '}
          {job.request.version ? <span className="job-version">{job.request.version}</span> : null}
        </h2>
        <div className="job-head-actions">
          {running ? (
            <button type="button" className="ghost-button" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="ghost-button" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>

      {job.state === 'downloading' ? (
        <div className="job-progress">
          <ProgressBar value={job.progress.bytesReceived} max={job.progress.bytesTotal} indeterminate={job.progress.bytesTotal == null} />
          <div className="job-progress-meta">
            <span>{job.progress.fileName ?? 'file'}</span>
            <span>
              {bytes(job.progress.bytesReceived)}
              {job.progress.bytesTotal ? ` / ${bytes(job.progress.bytesTotal)}` : ''}
            </span>
          </div>
        </div>
      ) : null}

      <div className="job-attempts">
        {job.attempts.map((attempt) => (
          <div key={attempt.providerId} className="attempt-row">
            <span className={`attempt-status attempt-${attempt.status}`}>
              {attempt.status === 'trying' ? <Spinner size={12} /> : attempt.status === 'ok' ? '✓' : attempt.status === 'failed' ? '✕' : '·'}
            </span>
            <div className="attempt-body">
              <div className="attempt-head">
                <span className="attempt-provider">{attempt.providerLabel}</span>
                <Badge tone={ATTEMPT_TONE[attempt.status] ?? 'neutral'}>{attempt.status}</Badge>
              </div>
              {attempt.detail ? <div className="attempt-detail">{attempt.detail}</div> : null}
              {attempt.urls?.length ? (
                <div className="attempt-urls">
                  {attempt.urls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="attempt-url">
                      {shorten(url)}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {verification ? (
        <div className="verification">
          <div className="verification-head">
            <h3>
              Verification <Badge tone={verification.status === 'pass' ? 'good' : verification.status === 'warn' ? 'warn' : 'bad'}>{verification.status}</Badge>
            </h3>
            <span className="verification-summary">{verification.summary}</span>
          </div>
          <div className="check-list">
            {verification.checks.map((check) => (
              <div key={check.id} className="check-row">
                <StatusDot status={check.status} />
                <span className="check-label">{check.label}</span>
                <span className="check-detail">{check.detail}</span>
              </div>
            ))}
          </div>
          {job.result ? (
            <div className="verification-actions">
              <a className="primary-button" href={libraryFileUrl(job.result.libraryId)} download>
                Save file to this device
              </a>
              <span className="fine-print">
                In Morphe Manager: Patch → select app → “Select an APK” and pick the file from PatchPilot’s library
                folder.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {job.error ? <div className="job-error">{job.error}</div> : null}

      <div className="job-log" ref={logRef}>
        {job.logs.map((line, index) => (
          <div key={`${line.at}-${index}`} className={`log-line log-${line.level}`}>
            <span className="log-time">{new Date(line.at).toLocaleTimeString()}</span>
            <span>{line.message}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function shorten(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 40 ? `${parsed.pathname.slice(0, 37)}…` : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}
