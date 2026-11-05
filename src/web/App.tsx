import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AppDetail,
  AppInfo,
  BundleInfo,
  CatalogResponse,
  DownloadJob,
  HealthResponse,
  LibraryEntry,
  ProviderInfo,
  Settings,
} from '../shared/types.ts';
import { api, watchJob } from './api.ts';
import { AppList } from './components/AppList.tsx';
import { AppView } from './components/AppView.tsx';
import { BundlesView } from './components/BundlesView.tsx';
import { DoctorView } from './components/DoctorView.tsx';
import { LogoMark } from './components/Logo.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { LibraryView } from './components/LibraryView.tsx';
import { SourcesView } from './components/SourcesView.tsx';
import { Badge, Spinner, ToastProvider, useToast } from './components/ui.tsx';
import { relativeTime } from './format.ts';

type Tab = 'apps' | 'library' | 'sources' | 'bundles' | 'doctor';

function Shell(): ReactNode {
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bundles, setBundles] = useState<BundleInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [tab, setTab] = useState<Tab>('apps');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadCatalog = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      try {
        const next = await api.catalog(refresh);
        setCatalog(next);
        setBundles(next.bundles);
        setError(null);
        setSelected((current) => current ?? next.apps[0]?.packageName ?? null);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary((await api.library()).entries);
    } catch {
      // Library is non-critical; the next refresh will retry.
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void loadLibrary();
    api.health().then(setHealth).catch(() => undefined);
    api.providers().then((result) => setProviders(result.providers)).catch(() => undefined);
    api.settings().then(setSettings).catch(() => undefined);
  }, [loadCatalog, loadLibrary]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .app(selected)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, catalog]);

  useEffect(() => {
    if (!job) return;
    if (['done', 'failed', 'cancelled'].includes(job.state)) {
      if (job.state === 'done') void loadLibrary();
      return;
    }
    return watchJob(job.id, (next) => setJob(next));
  }, [job?.id, job?.state, loadLibrary]);

  const apps = catalog?.apps ?? [];
  const app: AppInfo | null = useMemo(
    () => detail ?? apps.find((entry) => entry.packageName === selected) ?? null,
    [apps, detail, selected],
  );

  const startDownload = useCallback(
    async (version: string | null) => {
      if (!app) return;
      const trimmed = version && version !== app.recommendedVersion ? version : app.recommendedVersion;
      try {
        const created = await api.startDownload(app.packageName, trimmed ?? null);
        setJob(created);
      } catch (cause) {
        toast.push((cause as Error).message, 'bad');
      }
    },
    [app, toast],
  );

  const bundleSummary = useMemo(() => {
    const active = bundles.filter((bundle) => bundle.enabled);
    const patches = active.reduce((total, bundle) => total + bundle.patchCount, 0);
    return { active: active.length, patches };
  }, [bundles]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <LogoMark size={30} />
          <div>
            <div className="brand-name">PatchPilot</div>
            <div className="brand-sub">the right APK, before Morphe asks for it</div>
          </div>
        </div>

        <nav className="tabs">
          {(
            [
              ['apps', `Apps${catalog ? ` · ${catalog.appCount}` : ''}`],
              ['library', `Library${library.length ? ` · ${library.length}` : ''}`],
              ['sources', 'Sources'],
              ['bundles', `Bundles${bundleSummary.active ? ` · ${bundleSummary.active}` : ''}`],
              ['doctor', 'Doctor'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" className={`tab ${tab === id ? 'tab-active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-meta">
          <Badge tone="accent" title="Patches across the bundles your Morphe has loaded">
            {bundleSummary.patches} patches
          </Badge>
          <button type="button" className="ghost-button" onClick={() => void loadCatalog(true)} disabled={refreshing}>
            {refreshing ? <Spinner /> : '↻'} Reload
          </button>
        </div>
      </header>

      {health?.demoSource ? (
        <div className="banner banner-warn">
          Offline demo source is on: downloads are generated stand-ins signed with PatchPilot's test key. Turn it off in
          Sources to only use real mirrors.
        </div>
      ) : null}

      {error ? <div className="banner banner-bad">Could not load the catalog: {error}</div> : null}

      <main className="main">
        {tab === 'apps' ? (
          <div className="apps-layout">
            <aside className="sidebar">
              <AppList apps={apps} selected={selected} onSelect={setSelected} loading={loading} />
            </aside>
            <section className="content">
              {app ? (
                <AppView
                  app={app}
                  detail={detail}
                  job={job}
                  onDownload={startDownload}
                  onOpenJob={() => setJob(job)}
                  providers={providers}
                />
              ) : (
                <div className="empty-state">
                  {loading ? (
                    <>
                      <Spinner size={20} /> Loading patch bundles…
                    </>
                  ) : catalog?.morphe.loaded === 0 ? (
                    <>
                      <h2>Nothing loaded from Morphe yet</h2>
                      <p>
                        PatchPilot only offers the patches your Morphe has, so tell it which bundles those are. Paste
                        your Morphe sources, or flip on the ones you use — nothing is guessed.
                      </p>
                      <button type="button" className="primary-button" onClick={() => setTab('bundles')}>
                        Set up Morphe bundles
                      </button>
                    </>
                  ) : (
                    <>
                      <h2>No apps to show</h2>
                      <p>Your loaded bundles name no patchable apps yet. Try refreshing them in the Bundles tab.</p>
                    </>
                  )}
                </div>
              )}

              {job ? <JobPanel job={job} onCancel={() => api.cancelJob(job.id).catch(() => undefined)} onDismiss={() => setJob(null)} /> : null}
            </section>
          </div>
        ) : null}

        {tab === 'library' ? (
          <LibraryView
            entries={library}
            onChanged={loadLibrary}
            onGoToApps={() => setTab('apps')}
            apps={apps}
            onOpenApp={(packageName) => {
              setSelected(packageName);
              setTab('apps');
            }}
          />
        ) : null}

        {tab === 'doctor' ? <DoctorView /> : null}

        {tab === 'sources' ? (
          <SourcesView
            providers={providers}
            settings={settings}
            onChange={setProviders}
            onSettingsChange={setSettings}
            bundles={bundles}
            onSelectBundle={() => setTab('bundles')}
          />
        ) : null}

        {tab === 'bundles' ? (
          <BundlesView
            bundles={bundles}
            onChanged={(next) => {
              setBundles(next);
              void loadCatalog(true);
            }}
          />
        ) : null}
      </main>

      <footer className="footer">
        <span>
          Patches load from Morphe patch repositories; APKs come from official and third-party mirrors, then get checked
          against the bundle's package, version and signing certificate.
        </span>
        <span className="footer-meta">
          {health
            ? `v${health.version}${health.commit ? ` (${health.commit.slice(0, 7)})` : ''} · ${health.platform}`
            : null}
          {catalog ? ` · catalog ${relativeTime(catalog.generatedAt)}` : null}
        </span>
      </footer>
    </div>
  );
}

export function App(): ReactNode {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
