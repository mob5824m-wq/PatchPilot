import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CheckStatus, DoctorReport } from '../../shared/types.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { Badge, Card, Spinner } from './ui.tsx';

const TONES: Record<CheckStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  pass: 'good',
  warn: 'warn',
  fail: 'bad',
  skip: 'neutral',
};

const LABELS: Record<CheckStatus, string> = {
  pass: 'ok',
  warn: 'warning',
  fail: 'problem',
  skip: 'info',
};

/**
 * The Doctor: every reason a download can fail that is not the user's fault,
 * checked in one place — mirrors that block datacenter or carrier IPs, a bundle
 * that has not refreshed, a phone with no room left for a 200 MB bundle.
 *
 * The same checks run on the server and on the device; only the device-specific
 * ones (install permission, storage, notifications) differ.
 */
export function DoctorView(): ReactNode {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.doctor());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="doctor-view">
      <Card className="library-head">
        <div>
          <h1>Doctor</h1>
          <p className="fine-print">
            Reachability of every source, freshness of the patch bundles, storage and permissions.
            {report ? ` Last run ${relativeTime(report.generatedAt)} · ${report.mode === 'device' ? 'this device' : 'this server'}.` : ''}
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={() => void run()} disabled={busy}>
          {busy ? <Spinner size={12} /> : 'Run checks'}
        </button>
      </Card>

      {error ? <div className="banner banner-bad">Could not run the checks: {error}</div> : null}

      {report ? (
        <>
          <div className="doctor-summary">
            <Badge tone={report.summary.fail ? 'bad' : report.summary.warn ? 'warn' : 'good'}>
              {report.summary.pass} ok · {report.summary.warn} warnings · {report.summary.fail} problems
            </Badge>
          </div>

          <Card>
            <ul className="doctor-list">
              {report.checks.map((check) => (
                <li key={check.id} className={`doctor-row doctor-${check.status}`}>
                  <div className="doctor-head">
                    <span className="doctor-label">{check.label}</span>
                    <Badge tone={TONES[check.status]}>{LABELS[check.status]}</Badge>
                  </div>
                  <div className="doctor-detail">{check.detail}</div>
                  {check.hint ? <div className="doctor-hint">{check.hint}</div> : null}
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : busy ? (
        <div className="empty-state">
          <Spinner size={18} /> Checking sources, bundles and storage…
        </div>
      ) : null}
    </div>
  );
}
