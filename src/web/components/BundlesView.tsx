import { useRef, useState, type ReactNode } from 'react';
import type { BundleInfo } from '../../shared/types.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { Badge, Card, Spinner, Toggle, useToast } from './ui.tsx';

function originBadge(bundle: BundleInfo): ReactNode {
  if (bundle.origin === 'network') return <Badge tone="good">live</Badge>;
  if (bundle.origin === 'cache') return <Badge tone={bundle.stale ? 'warn' : 'info'}>cached</Badge>;
  if (bundle.origin === 'seed') return <Badge tone="warn">bundled snapshot</Badge>;
  if (bundle.origin === 'upload') return <Badge tone="info">uploaded</Badge>;
  return <Badge>not loaded</Badge>;
}

export function BundlesView({
  bundles,
  onChanged,
}: {
  bundles: BundleInfo[];
  onChanged: (bundles: BundleInfo[]) => void;
}): ReactNode {
  const toast = useToast();
  const [sourcesText, setSourcesText] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addRepo(): Promise<void> {
    if (!repo.trim()) return;
    setBusy('add');
    try {
      await api.addBundle(repo.trim(), name.trim() || undefined);
      const next = await api.bundles();
      onChanged(next.bundles);
      toast.push('Bundle added.', 'good');
      setRepo('');
      setName('');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function importSources(): Promise<void> {
    if (!sourcesText.trim()) return;
    setBusy('import');
    try {
      const result = await api.importBundles(sourcesText);
      onChanged(result.bundles);
      const done = [...result.added, ...result.enabled];
      const skipped = result.skipped.length;
      if (!done.length && !skipped) {
        toast.push('Nothing in that list looked like a bundle — no changes made.', 'info');
      } else if (!done.length) {
        toast.push(`Nothing imported. ${result.skipped[0]?.reason ?? ''}`.trim(), 'bad');
      } else {
        toast.push(
          `Imported ${done.length} bundle${done.length === 1 ? '' : 's'}${
            skipped ? ` · ${skipped} line${skipped === 1 ? '' : 's'} skipped` : ''
          }`,
          'good',
        );
      }
      if (done.length) setSourcesText('');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File): Promise<void> {
    setBusy('upload');
    try {
      await api.uploadBundle(file);
      const next = await api.bundles();
      onChanged(next.bundles);
      toast.push(`Loaded ${file.name}`, 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function refresh(id?: string): Promise<void> {
    setBusy(id ?? 'all');
    try {
      const result = id ? await api.refreshBundle(id) : await api.refreshAllBundles();
      onChanged(result.bundles);
      toast.push('Bundles refreshed.', 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(bundle: BundleInfo, enabled: boolean): Promise<void> {
    try {
      const result = await api.toggleBundle(bundle.id, enabled);
      onChanged(result.bundles);
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    }
  }

  async function remove(bundle: BundleInfo): Promise<void> {
    setBusy(bundle.id);
    try {
      await api.removeBundle(bundle.id);
      const next = await api.bundles();
      onChanged(next.bundles);
      toast.push(`${bundle.name} removed.`, 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function reset(): Promise<void> {
    setBusy('reset');
    try {
      const result = await api.resetBundles();
      onChanged(result.bundles);
      toast.push('Bundles reset to defaults.', 'good');
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bundles-view">
      <Card className="sources-intro">
        <h1>Your Morphe patches</h1>
        <p>
          PatchPilot only offers patches from the bundles your Morphe has loaded — anything else would suggest apps your
          patches cannot touch. A bundle publishes <code>patches-list.json</code>, naming the exact versions its patches
          accept; PatchPilot reads the same file, including from a <code>.mpp</code> you drop in.
        </p>
        <div className="bundle-actions">
          <button type="button" className="ghost-button" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === 'all' ? <Spinner size={12} /> : '↻'} Refresh all
          </button>
          <button type="button" className="ghost-button" onClick={() => void reset()} disabled={busy !== null}>
            Reset to known bundles
          </button>
        </div>
      </Card>

      {!bundles.some((bundle) => bundle.enabled) ? (
        <div className="banner banner-warn">
          Nothing is loaded yet, so the app catalog is empty. Import the sources your Morphe has, or flip on a bundle
          below — PatchPilot never assumes.
        </div>
      ) : null}

      <div className="bundle-list">
        {bundles.map((bundle) => (
          <Card key={bundle.id} className={`bundle-card ${bundle.enabled ? '' : 'provider-disabled'}`}>
            <div className="provider-head">
              <div>
                <h2>
                  {bundle.name} {originBadge(bundle)}
                  {bundle.builtin ? <Badge>built in</Badge> : null}
                </h2>
                <div className="provider-link">
                  {bundle.repo ? (
                    <a href={`https://github.com/${bundle.repo}`} target="_blank" rel="noreferrer noopener">
                      github.com/{bundle.repo}
                    </a>
                  ) : (
                    bundle.kind
                  )}
                </div>
              </div>
              <div className="provider-controls">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy === bundle.id || bundle.kind === 'upload'}
                  onClick={() => void refresh(bundle.id)}
                >
                  {busy === bundle.id ? <Spinner size={12} /> : 'Refresh'}
                </button>
                {!bundle.builtin ? (
                  <button type="button" className="ghost-button danger" onClick={() => void remove(bundle)} disabled={busy === bundle.id}>
                    Remove
                  </button>
                ) : null}
                <Toggle
                  checked={bundle.enabled}
                  onChange={(next) => void toggle(bundle, next)}
                  label={`Loaded in Morphe: ${bundle.name}`}
                />
              </div>
            </div>

            <div className="bundle-stats">
              <div>
                <span className="metric">{bundle.version ?? '—'}</span>
                <span className="metric-label">bundle version</span>
              </div>
              <div>
                <span className="metric">{bundle.patchCount}</span>
                <span className="metric-label">patches</span>
              </div>
              <div>
                <span className="metric">{bundle.packageCount}</span>
                <span className="metric-label">apps</span>
              </div>
              <div>
                <span className="metric">{relativeTime(bundle.fetchedAt)}</span>
                <span className="metric-label">last fetched</span>
              </div>
            </div>

            {bundle.error ? <div className="bundle-error">{bundle.error}</div> : null}
            {bundle.downloadUrl ? (
              <a className="provider-link" href={bundle.downloadUrl} target="_blank" rel="noreferrer noopener">
                Download the .mpp bundle for Morphe
              </a>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="bundle-add-grid">
        <Card>
          <div className="card-head">
            <h2>Import from Morphe</h2>
          </div>
          <p className="fine-print">
            Copy the sources from Morphe's patch-source screen — one repository per line, <code>owner/repo</code> or a
            full GitHub URL. Anything already known is switched on; anything new is fetched. Lines it cannot use are
            reported, never guessed at.
          </p>
          <textarea
            className="mono-input"
            rows={4}
            placeholder={'MorpheApp/morphe-patches\nhxreborn/morphe-patches'}
            value={sourcesText}
            onChange={(event) => setSourcesText(event.target.value)}
          />
          <button
            type="button"
            className="primary-button"
            onClick={() => void importSources()}
            disabled={busy !== null || !sourcesText.trim()}
          >
            {busy === 'import' ? <Spinner size={12} /> : 'Import sources'}
          </button>
        </Card>

        <Card>
          <div className="card-head">
            <h2>Add a GitHub bundle</h2>
          </div>
          <p className="fine-print">
            Any repository that publishes <code>patches-list.json</code> at its root works — the layout every Morphe
            patch repo uses.
          </p>
          <label className="field">
            <span>Repository</span>
            <input
              type="text"
              placeholder="owner/morphe-patches"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addRepo();
              }}
            />
          </label>
          <label className="field">
            <span>Display name (optional)</span>
            <input type="text" placeholder="My patches" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="button" className="primary-button" onClick={() => void addRepo()} disabled={busy !== null || !repo.trim()}>
            {busy === 'add' ? <Spinner size={12} /> : 'Add bundle'}
          </button>
        </Card>

        <Card>
          <div className="card-head">
            <h2>Load a .mpp file</h2>
          </div>
          <p className="fine-print">
            Point PatchPilot at a bundle you already downloaded: it reads the same <code>patches-list.json</code> that
            Morphe would.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".mpp,.json,.zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {busy === 'upload' ? (
            <div className="fine-print">
              <Spinner size={12} /> Reading bundle…
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
