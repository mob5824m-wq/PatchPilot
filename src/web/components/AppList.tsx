import { useMemo, useState, type ReactNode } from 'react';
import type { AppInfo } from '../../shared/types.ts';
import { appInitials, iconStyle } from '../format.ts';
import { Badge, Spinner } from './ui.tsx';

export function AppList({
  apps,
  selected,
  onSelect,
  loading,
}: {
  apps: AppInfo[];
  selected: string | null;
  onSelect: (packageName: string) => void;
  loading: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [stableOnly, setStableOnly] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (stableOnly && app.experimentalOnly) return false;
      if (!needle) return true;
      return (
        app.name.toLowerCase().includes(needle) ||
        app.packageName.toLowerCase().includes(needle) ||
        app.bundles.some((bundle) => bundle.name.toLowerCase().includes(needle))
      );
    });
  }, [apps, query, stableOnly]);

  return (
    <div className="app-list">
      <div className="search-row">
        <input
          className="search-input"
          type="search"
          placeholder="Search apps or packages…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search apps"
        />
      </div>

      <label className="checkbox-row">
        <input type="checkbox" checked={stableOnly} onChange={(event) => setStableOnly(event.target.checked)} />
        <span>Only apps with a stable version</span>
      </label>

      <div className="app-list-scroll">
        {loading ? (
          <div className="app-list-loading">
            <Spinner /> Loading bundles…
          </div>
        ) : null}
        {!loading && filtered.length === 0 ? <div className="app-list-empty">No app matches that search.</div> : null}
        {filtered.map((app) => (
          <button
            key={app.packageName}
            type="button"
            className={`app-row ${selected === app.packageName ? 'app-row-active' : ''}`}
            onClick={() => onSelect(app.packageName)}
          >
            <span className="app-icon" style={iconStyle(app.iconColor)}>
              {appInitials(app.name)}
            </span>
            <span className="app-row-text">
              <span className="app-row-name">{app.name}</span>
              <span className="app-row-package">{app.packageName}</span>
              <span className="app-row-meta">
                {app.patchCount} patch{app.patchCount === 1 ? '' : 'es'} · {app.targets.length} version
                {app.targets.length === 1 ? '' : 's'}
              </span>
            </span>
            {app.experimentalOnly ? <Badge tone="warn">exp</Badge> : null}
          </button>
        ))}
      </div>

      <div className="app-list-footer">
        {filtered.length} of {apps.length} apps
      </div>
    </div>
  );
}
