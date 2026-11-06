import { useMemo, useState, type ReactNode } from 'react';
import type { AppDetail, AppInfo, DownloadJob, ProviderInfo } from '../../shared/types.ts';
import { appInitials, fileTypeLabel, iconStyle } from '../format.ts';
import { Badge, Card, StatusDot } from './ui.tsx';

export function AppView({
  app,
  detail,
  job,
  onDownload,
  onQueue,
  onOpenJob,
  providers,
}: {
  app: AppInfo;
  detail: AppDetail | null;
  job: DownloadJob | null;
  onDownload: (version: string | null) => void;
  onQueue: () => void;
  onOpenJob: () => void;
  providers: ProviderInfo[];
}): ReactNode {
  const [version, setVersion] = useState<string | null>(null);
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [showPatches, setShowPatches] = useState(false);

  const activeVersion = useMemo(() => {
    if (version && app.targets.some((target) => target.version === version)) return version;
    return app.recommendedVersion;
  }, [app, version]);

  const target = app.targets.find((entry) => entry.version === activeVersion) ?? null;
  const visibleTargets = showAllVersions ? app.targets : app.targets.slice(0, 6);
  const busy = job ? !['done', 'failed', 'cancelled'].includes(job.state) : false;
  const enabledSources = providers.filter((provider) => provider.enabled && provider.id !== 'demo').length;
  const patches = detail?.patches ?? [];
  const patchesForVersion = target ? target.patches.length : 0;

  return (
    <div className="app-view">
      <Card className="hero">
        <div className="hero-main">
          <span className="app-icon app-icon-lg" style={iconStyle(app.iconColor)}>
            {appInitials(app.name)}
          </span>
          <div className="hero-text">
            <h1>{app.name}</h1>
            <div className="hero-package">{app.packageName}</div>
            <div className="hero-badges">
              <Badge tone="info">{fileTypeLabel(app.fileType)}</Badge>
              {app.formFactor !== 'UNKNOWN' ? <Badge>{app.formFactor}</Badge> : null}
              <Badge tone="accent">{app.patchCount} patches</Badge>
              {app.bundles.map((bundle) => (
                <Badge key={bundle.id} title={`${bundle.patchCount} patches from ${bundle.name}`}>
                  {bundle.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <div className="hero-side">
          <div className="hero-side-label">Recommended version</div>
          <div className="hero-version">{app.recommendedVersion ?? '—'}</div>
          {target?.versionCodes ? (
            <div className="hero-version-code">
              versionCode{' '}
              {Object.entries(target.versionCodes)
                .slice(0, 2)
                .map(([abi, code]) => `${code} (${abi.toLowerCase().replace(/_/g, '-')})`)
                .join(' · ')}
            </div>
          ) : null}
          <div className="hero-side-label hero-side-label-spaced">Patches for this version</div>
          <div className="hero-version">{patchesForVersion}</div>
        </div>
      </Card>

      <div className="app-grid">
        <Card className="versions-card">
          <div className="card-head">
            <h2>Supported versions</h2>
            <span className="card-head-note">
              {app.latestStableVersion ? `newest stable ${app.latestStableVersion}` : 'no stable version'}
              {app.latestVersion && app.latestVersion !== app.latestStableVersion ? ` · newest ${app.latestVersion}` : ''}
            </span>
          </div>

          <div className="version-list" role="radiogroup" aria-label="Supported versions">
            {visibleTargets.map((entry) => {
              const recommended = entry.version === app.recommendedVersion;
              const selected = entry.version === activeVersion;
              return (
                <button
                  key={entry.version}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`version-row ${selected ? 'version-row-active' : ''}`}
                  onClick={() => setVersion(entry.version)}
                >
                  <span className={`radio ${selected ? 'radio-on' : ''}`} aria-hidden />
                  <span className="version-main">
                    <span className="version-name">{entry.version}</span>
                    <span className="version-meta">
                      {entry.patchCount} patch{entry.patchCount === 1 ? '' : 'es'}
                      {entry.minSdk ? ` · minSdk ${entry.minSdk}` : ''}
                      {entry.versionCodes ? ` · versionCode ${Object.values(entry.versionCodes)[0]}` : ''}
                    </span>
                  </span>
                  <span className="version-badges">
                    {recommended ? <Badge tone="good">recommended</Badge> : null}
                    {entry.isExperimental ? <Badge tone="warn">experimental</Badge> : null}
                  </span>
                </button>
              );
            })}
          </div>

          {app.targets.length > 6 ? (
            <button type="button" className="link-button" onClick={() => setShowAllVersions((current) => !current)}>
              {showAllVersions ? 'Show fewer versions' : `Show all ${app.targets.length} versions`}
            </button>
          ) : null}

          <div className="download-actions">
            <button type="button" className="primary-button" disabled={busy || !activeVersion} onClick={() => onDownload(activeVersion)}>
              {busy ? 'Working…' : `Download APK for ${activeVersion ?? '—'}`}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={!activeVersion}
              title="Download this later, after the other apps already queued"
              onClick={onQueue}
            >
              ⧉ Add to queue
            </button>
            {job ? (
              <button type="button" className="ghost-button" onClick={onOpenJob}>
                View last attempt
              </button>
            ) : null}
          </div>
          <p className="fine-print">
            {enabledSources} real source{enabledSources === 1 ? '' : 's'} enabled · Morphe needs an unmodified APK of
            exactly this version, so PatchPilot refuses anything else.
          </p>
        </Card>

        <Card className="patches-card">
          <div className="card-head">
            <h2>Patches</h2>
            <button type="button" className="link-button" onClick={() => setShowPatches((current) => !current)}>
              {showPatches ? 'Hide list' : `Show ${patches.length}`}
            </button>
          </div>

          <div className="patch-summary">
            <div>
              <span className="metric">{app.patchCount}</span>
              <span className="metric-label">patches across bundles</span>
            </div>
            <div>
              <span className="metric">{app.targets.length}</span>
              <span className="metric-label">supported versions</span>
            </div>
            <div>
              <span className="metric">{app.signatures.length}</span>
              <span className="metric-label">known signing certs</span>
            </div>
          </div>

          {app.signatures.length ? (
            <div className="signature-block">
              <div className="signature-title">Expected signing certificate</div>
              {app.signatures.map((signature) => (
                <code key={signature} className="signature-hash" title="SHA-256 of the app's signing certificate">
                  {signature.slice(0, 32)}…
                </code>
              ))}
              <p className="fine-print">
                Downloads are checked against this fingerprint, which is how PatchPilot knows it got the real app and
                not a repack.
              </p>
            </div>
          ) : null}

          {showPatches ? (
            <div className="patch-list">
              {patches.map((patch) => {
                const supportsVersion = activeVersion ? patch.versions.includes(activeVersion) : false;
                return (
                  <div key={`${patch.bundleId}:${patch.name}`} className={`patch-row ${supportsVersion ? '' : 'patch-row-dim'}`}>
                    <div className="patch-row-head">
                      <span className="patch-name">{patch.name}</span>
                      <span className="patch-badges">
                        {patch.isDefault ? <Badge tone="good">default</Badge> : null}
                        {supportsVersion && patch.experimentalVersions.includes(activeVersion ?? '') ? (
                          <Badge tone="warn">experimental here</Badge>
                        ) : null}
                        <Badge>{patch.bundleName}</Badge>
                      </span>
                    </div>
                    {patch.description ? <p className="patch-description">{patch.description}</p> : null}
                    <div className="patch-versions">
                      <StatusDot status={supportsVersion ? 'pass' : 'skip'} />
                      {patch.versions.length} version{patch.versions.length === 1 ? '' : 's'}
                      {patch.versions.length <= 8 ? `: ${patch.versions.join(', ')}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="patch-preview">
              {patches.slice(0, 6).map((patch) => (
                <li key={`${patch.bundleId}:${patch.name}`}>
                  <span>{patch.name}</span>
                  <span className="patch-preview-bundle">{patch.bundleName}</span>
                </li>
              ))}
              {patches.length > 6 ? <li className="patch-preview-more">+{patches.length - 6} more…</li> : null}
              {!patches.length ? <li className="patch-preview-more">Select the app to load its patch list.</li> : null}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
