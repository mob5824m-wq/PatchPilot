import { useMemo, useState, type ReactNode } from 'react';
import type { BundleInfo, ProviderInfo, Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { Badge, Card, Spinner, Toggle, useToast } from './ui.tsx';

interface ProbeState {
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  detail: string;
}

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

export function SourcesView({
  providers,
  settings,
  onChange,
  onSettingsChange,
  bundles,
  onSelectBundle,
}: {
  providers: ProviderInfo[];
  settings: Settings | null;
  onChange: (providers: ProviderInfo[]) => void;
  onSettingsChange: (settings: Settings) => void;
  bundles: BundleInfo[];
  onSelectBundle: () => void;
}): ReactNode {
  const toast = useToast();
  const [probes, setProbes] = useState<Record<string, ProbeState | 'probing'>>({});

  const ordered = useMemo(() => [...providers].sort((a, b) => a.order - b.order), [providers]);

  async function toggle(provider: ProviderInfo, enabled: boolean): Promise<void> {
    try {
      const result = await api.toggleProvider(provider.id, enabled);
      onChange(result.providers);
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    }
  }

  async function runProbe(provider: ProviderInfo): Promise<void> {
    setProbes((current) => ({ ...current, [provider.id]: 'probing' }));
    try {
      const result = await api.probeProvider(provider.id);
      setProbes((current) => ({ ...current, [provider.id]: result }));
    } catch (cause) {
      setProbes((current) => ({
        ...current,
        [provider.id]: { reachable: false, status: null, latencyMs: null, detail: (cause as Error).message },
      }));
    }
  }

  async function move(provider: ProviderInfo, direction: -1 | 1): Promise<void> {
    const index = ordered.findIndex((entry) => entry.id === provider.id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved as ProviderInfo);
    try {
      const result = await api.orderProviders(next.map((entry) => entry.id));
      onChange(result.providers);
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
    }
  }

  async function saveSettings(patch: Partial<Settings>): Promise<void> {
    if (!settings) return;
    const optimistic = { ...settings, ...patch };
    onSettingsChange(optimistic);
    try {
      onSettingsChange(await api.saveSettings(patch));
    } catch (cause) {
      toast.push((cause as Error).message, 'bad');
      onSettingsChange(settings);
    }
  }

  const bundleIssues = bundles.filter((bundle) => bundle.enabled && (bundle.origin === 'seed' || bundle.stale));

  return (
    <div className="sources-view">
      <Card className="sources-intro">
        <h1>Sources</h1>
        <p>
          PatchPilot asks these sources in order, trying to fetch the exact build the patches name. Anything it
          downloads is verified before it reaches the library, so a mirror returning the wrong version — or a repack —
          is rejected instead of patched.
        </p>
        {bundleIssues.length ? (
          <div className="banner banner-warn inline">
            {bundleIssues.length} enabled bundle{bundleIssues.length === 1 ? ' is' : 's are'} running from a bundled
            snapshot instead of a live fetch.{' '}
            <button type="button" className="link-button" onClick={onSelectBundle}>
              Manage bundles
            </button>
          </div>
        ) : null}
      </Card>

      <div className="provider-list">
        {ordered.map((provider, index) => {
          const probe = probes[provider.id];
          return (
            <Card key={provider.id} className={`provider-card ${provider.enabled ? '' : 'provider-disabled'}`}>
              <div className="provider-head">
                <div className="provider-title">
                  <span className="provider-index">{index + 1}</span>
                  <div>
                    <h2>
                      {provider.label}{' '}
                      <Badge tone={provider.kind === 'file' ? 'good' : 'info'}>
                        {provider.kind === 'file' ? 'file' : 'page'}
                      </Badge>
                    </h2>
                    <a href={provider.homepage} target="_blank" rel="noreferrer noopener" className="provider-link">
                      {new URL(provider.homepage).host}
                    </a>
                  </div>
                </div>
                <div className="provider-controls">
                  <button type="button" className="icon-button" onClick={() => void move(provider, -1)} disabled={index === 0} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => void move(provider, 1)}
                    disabled={index === ordered.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button type="button" className="ghost-button" onClick={() => void runProbe(provider)} disabled={probe === 'probing'}>
                    {probe === 'probing' ? <Spinner size={12} /> : 'Test'}
                  </button>
                  <Toggle checked={provider.enabled} onChange={(next) => void toggle(provider, next)} label={`Enable ${provider.label}`} />
                </div>
              </div>

              <p className="provider-description">{provider.description}</p>

              {provider.notes.length ? (
                <ul className="provider-notes">
                  {provider.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}

              {probe && probe !== 'probing' ? (
                <div className={`probe-result ${probe.reachable ? 'probe-ok' : 'probe-bad'}`}>
                  {probe.reachable ? '✓ reachable' : '✕ unreachable'}
                  {probe.status ? ` · HTTP ${probe.status}` : ''}
                  {probe.latencyMs ? ` · ${probe.latencyMs} ms` : ''} — {probe.detail}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Card className="settings-card">
        <div className="card-head">
          <h2>Download preferences</h2>
        </div>

        <label className="field">
          <span>Preferred ABI when the bundle pins version codes</span>
          <select
            value={settings?.preferAbi ?? ''}
            onChange={(event) => void saveSettings({ preferAbi: event.target.value || null })}
          >
            <option value="">Let the source decide</option>
            {ABIS.map((abi) => (
              <option key={abi} value={abi}>
                {abi}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Refresh bundles automatically every</span>
          <select
            value={String(settings?.autoRefreshMinutes ?? 180)}
            onChange={(event) => void saveSettings({ autoRefreshMinutes: Number(event.target.value) })}
          >
            <option value="30">30 minutes</option>
            <option value="180">3 hours</option>
            <option value="720">12 hours</option>
            <option value="0">never</option>
          </select>
        </label>
      </Card>

      <Card className="legal-card">
        <div className="card-head">
          <h2>Please read</h2>
        </div>
        <ul className="provider-notes">
          <li>Only download and patch apps you are licensed to use. PatchPilot does not host or redistribute APKs.</li>
          <li>Third-party mirrors have their own terms; several rate limit or block automated access from datacenters.</li>
          <li>
            Morphe needs the stock, unmodified APK of the exact version. PatchPilot verifies the package, version code
            and signing certificate, but you are the one deciding to patch.
          </li>
        </ul>
      </Card>
    </div>
  );
}
