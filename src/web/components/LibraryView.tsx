import { useRef, useState, type ReactNode } from 'react';
import type { AppInfo, LibraryEntry, VerificationResult } from '../../shared/types.ts';
import { api, libraryFileUrl } from '../api.ts';
import { bytes, relativeTime } from '../format.ts';
import { Badge, Card, Spinner, StatusDot, useToast } from './ui.tsx';

export function LibraryView({
  entries,
  onChanged,
  apps,
  onOpenApp,
  onGoToApps,
}: {
  entries: LibraryEntry[];
  onChanged: () => Promise<void>;
  apps: AppInfo[];
  onOpenApp: (packageName: string) => void;
  onGoToApps: () => void;
}): ReactNode {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [verification, setVerification] = useState<{
    result: VerificationResult;
    kept: boolean;
    file: File;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedApp, setSelectedApp] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const libraryTotal = entries.reduce((total, entry) => total + entry.sizeBytes, 0);

  async function copyLink(entry: LibraryEntry): Promise<void> {
    const url = `${window.location.origin}/api/library/${encodeURIComponent(entry.id)}/file`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push('Link copied — open it on your phone (same Wi-Fi) to download.', 'good');
    } catch {
      toast.push(url, 'info');
    }
  }

  async function handleFile(file: File): Promise<void> {
    setUploading(true);
    setPendingFile(file);
    try {
      const app = apps.find((entry) => entry.packageName === selectedApp);
      const version = app ? app.recommendedVersion : undefined;
      const response = await api.verifyFile(file, app?.packageName, version ?? undefined, false);
      setVerification({ result: response.verification, kept: false, file });
      toast.push(
        response.verification.status === 'fail'
          ? 'That file does not match the bundle.'
          : 'File checked — you can add it to the library.',
        response.verification.status === 'fail' ? 'bad' : 'good',
      );
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function keepInLibrary(): Promise<void> {
    if (!pendingFile) {
      toast.push('Choose the file again to add it.', 'bad');
      return;
    }
    const app = apps.find((entry) => entry.packageName === selectedApp);
    setUploading(true);
    try {
      const response = await api.verifyFile(pendingFile, app?.packageName, app?.recommendedVersion ?? undefined, true);
      setVerification({ result: response.verification, kept: Boolean(response.libraryEntry), file: pendingFile });
      setPendingFile(null);
      await onChanged();
      toast.push('Added to the library.', 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setUploading(false);
    }
  }

  async function remove(entry: LibraryEntry): Promise<void> {
    setBusyId(entry.id);
    try {
      await api.removeLibraryEntry(entry.id);
      await onChanged();
      toast.push(`Removed ${entry.fileName}`, 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="library-view">
      <Card className="library-head">
        <div>
          <h1>Library</h1>
          <p className="fine-print">
            Verified APKs land here, ready for Morphe's file picker. {entries.length} file
            {entries.length === 1 ? '' : 's'} · {bytes(libraryTotal)} on disk. Copy a link and open it on your phone
            (same Wi-Fi) to pull the file straight into it.
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={onGoToApps}>
          Back to apps
        </button>
      </Card>

      <div className="library-grid">
        <Card className="library-table-card">
          {entries.length === 0 ? (
            <div className="empty-state compact">
              <h2>Nothing here yet</h2>
              <p>Pick an app, choose the version its patches need, and PatchPilot will fetch and check it.</p>
              <button type="button" className="primary-button" onClick={onGoToApps}>
                Browse apps
              </button>
            </div>
          ) : (
            <table className="library-table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Version</th>
                  <th>Source</th>
                  <th>Checked</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="library-app">
                        {entry.packageName && apps.some((app) => app.packageName === entry.packageName) ? (
                          <button
                            type="button"
                            className="link-button library-app-name"
                            title="Open this app's versions"
                            onClick={() => onOpenApp(entry.packageName!)}
                          >
                            {entry.appName ?? entry.packageName}
                          </button>
                        ) : (
                          <span className="library-app-name">{entry.appName ?? entry.packageName ?? 'Unknown app'}</span>
                        )}
                        <span className="library-file">{entry.fileName}</span>
                      </div>
                    </td>
                    <td>
                      <div className="library-version">{entry.versionName ?? '—'}</div>
                      <div className="library-file">{entry.container.toUpperCase()}</div>
                    </td>
                    <td>
                      <div className="library-source">{entry.providerId ?? 'manual'}</div>
                      <div className="library-file">{relativeTime(entry.createdAt)}</div>
                    </td>
                    <td>
                      {entry.demo ? (
                        <Badge tone="warn" title="Generated by the offline demo source">
                          demo fixture
                        </Badge>
                      ) : entry.verificationStatus === 'pass' ? (
                        <Badge tone="good">verified</Badge>
                      ) : entry.verificationStatus === 'warn' ? (
                        <Badge tone="warn">verified with warnings</Badge>
                      ) : (
                        <Badge>unchecked</Badge>
                      )}
                    </td>
                    <td className="library-size">{bytes(entry.sizeBytes)}</td>
                    <td className="library-actions">
                      <a className="ghost-button" href={libraryFileUrl(entry.id)} download>
                        Save
                      </a>
                      <button type="button" className="ghost-button" onClick={() => void copyLink(entry)}>
                        Link
                      </button>
                      <button
                        type="button"
                        className="ghost-button danger"
                        disabled={busyId === entry.id}
                        onClick={() => void remove(entry)}
                      >
                        {busyId === entry.id ? <Spinner size={12} /> : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="verify-card">
          <div className="card-head">
            <h2>Verify a file you already have</h2>
          </div>
          <p className="fine-print">
            Downloaded an APK elsewhere? Drop it here before patching: PatchPilot reads its manifest and signing
            certificate and tells you whether the patches will accept it.
          </p>

          <label className="field">
            <span>Check against app (optional)</span>
            <select value={selectedApp} onChange={(event) => setSelectedApp(event.target.value)}>
              <option value="">— detect from the file —</option>
              {apps.map((app) => (
                <option key={app.packageName} value={app.packageName}>
                  {app.name} ({app.recommendedVersion ?? 'no version'})
                </option>
              ))}
            </select>
          </label>

          <div
            className="dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".apk,.apkm,.xapk,.apks,.zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <div className="dropzone-text">
              {uploading ? (
                <>
                  <Spinner /> Checking {pendingFile?.name ?? 'file'}…
                </>
              ) : (
                <>Drop an .apk / .apkm / .xapk here, or click to choose</>
              )}
            </div>
          </div>

          {verification ? (
            <div className="verify-result">
              <div className="verification-head">
                <h3>
                  {verification.result.summary}{' '}
                  <Badge
                    tone={
                      verification.result.status === 'pass' ? 'good' : verification.result.status === 'warn' ? 'warn' : 'bad'
                    }
                  >
                    {verification.result.status}
                  </Badge>
                </h3>
              </div>
              <div className="check-list">
                {verification.result.checks.map((check) => (
                  <div key={check.id} className="check-row">
                    <StatusDot status={check.status} />
                    <span className="check-label">{check.label}</span>
                    <span className="check-detail">{check.detail}</span>
                  </div>
                ))}
              </div>
              {!verification.kept && verification.result.status !== 'fail' ? (
                <button type="button" className="primary-button" onClick={() => void keepInLibrary()} disabled={uploading}>
                  Add to library
                </button>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
