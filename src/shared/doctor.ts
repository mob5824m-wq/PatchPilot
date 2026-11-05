import type {
  BundleInfo,
  CheckStatus,
  DoctorCheck,
  DoctorReport,
  LibraryEntry,
  MorpheDiscovery,
  Settings,
} from './types.ts';
import { request } from '../server/http.ts';
import type { Provider } from '../server/providers/types.ts';

/**
 * The checks behind the Doctor screen: everything that can make a download fail
 * for a reason that is nobody's fault — a blocked mirror, a stale bundle, a full
 * disk — gathered into one page instead of five error messages spread over
 * three tabs.
 */

export function summarise(checks: DoctorCheck[]): DoctorReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

export function report(mode: DoctorReport['mode'], checks: DoctorCheck[]): DoctorReport {
  return { generatedAt: new Date().toISOString(), mode, checks, summary: summarise(checks) };
}

export function worst(checks: DoctorCheck[]): CheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  if (checks.some((check) => check.status === 'pass')) return 'pass';
  return 'skip';
}

/**
 * Morphe: whether PatchPilot has read the app's sources yet, and what that read
 * achieved. Android hides another app's files, so "not found" is a fact to
 * report rather than a failure to work around.
 */
export function morpheCheck(discovery: MorpheDiscovery | null | undefined): DoctorCheck {
  if (!discovery) {
    return {
      id: 'morphe',
      label: 'Morphe Manager',
      status: 'warn',
      detail: 'Not read yet — the catalogue starts empty until PatchPilot knows which bundles your Morphe has.',
      hint: 'Bundles tab → Read from Morphe, or paste your sources.',
    };
  }

  const names = discovery.installed.map((entry) => entry.package).join(', ');
  if (!discovery.installed.length) {
    return {
      id: 'morphe',
      label: 'Morphe Manager',
      status: 'skip',
      detail: 'Not installed on this device, so there is nothing to read.',
      hint: 'Add the bundle repositories by hand in the Bundles tab.',
    };
  }

  if (discovery.found) {
    const parts: string[] = [];
    if (discovery.added.length) parts.push(`${discovery.added.length} added`);
    if (discovery.enabled.length) parts.push(`${discovery.enabled.length} switched on`);
    return {
      id: 'morphe',
      label: 'Morphe Manager',
      status: 'pass',
      detail: `Read ${discovery.filesRead} file${discovery.filesRead === 1 ? '' : 's'} from ${names}${parts.length ? ` — ${parts.join(', ')}` : ''}.`,
      hint: null,
    };
  }

  return {
    id: 'morphe',
    label: 'Morphe Manager',
    status: 'warn',
    detail: `${names} is installed, but Android keeps its source list private to it.`,
    hint: 'Paste the sources once in the Bundles tab — PatchPilot keeps them.',
  };
}

/** Bundles: loaded at all, current enough, and not sitting on an error. */
export function bundleChecks(infos: BundleInfo[], options: { staleDays?: number } = {}): DoctorCheck[] {
  const staleDays = options.staleDays ?? 14;
  const enabled = infos.filter((info) => info.enabled);
  if (!enabled.length) {
    return [
      {
        id: 'bundles',
        label: 'Patch bundles',
        status: 'fail',
        detail: 'No Morphe bundle is loaded, so there is nothing to patch.',
        hint: 'Import your Morphe sources in the Bundles tab — PatchPilot offers only what your Morphe has.',
      },
    ];
  }

  const empty = enabled.filter((info) => info.patchCount === 0);
  const errored = enabled.filter((info) => info.error);
  const newest = enabled
    .map((info) => (info.fetchedAt ? Date.parse(info.fetchedAt) : 0))
    .reduce((latest, value) => Math.max(latest, value), 0);
  const ageDays = newest ? (Date.now() - newest) / 86_400_000 : Number.POSITIVE_INFINITY;

  const detail = `${enabled.length} loaded · ${enabled.reduce((total, info) => total + info.patchCount, 0)} patches · ${
    newest ? `${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} old` : 'never fetched'
  }`;

  if (errored.length) {
    return [
      {
        id: 'bundles',
        label: 'Patch bundles',
        status: 'warn',
        detail: `${errored.map((info) => info.name).join(', ')} could not refresh — showing the last good copy. (${detail})`,
        hint: 'Try Refresh all in the Bundles tab. GitHub rate limits reset hourly.',
      },
    ];
  }
  if (empty.length) {
    return [
      { id: 'bundles', label: 'Patch bundles', status: 'fail', detail: `Empty bundle: ${empty.map((info) => info.name).join(', ')}`, hint: null },
    ];
  }
  if (ageDays > staleDays) {
    return [
      {
        id: 'bundles',
        label: 'Patch bundles',
        status: 'warn',
        detail,
        hint: 'Refresh to pick up patches published since this copy was fetched.',
      },
    ];
  }
  return [{ id: 'bundles', label: 'Patch bundles', status: 'pass', detail, hint: null }];
}

/** Library: how much is there, and whether anything is unchecked. */
export function libraryChecks(entries: LibraryEntry[]): DoctorCheck[] {
  const bytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  const demo = entries.filter((entry) => entry.demo).length;
  const unchecked = entries.filter((entry) => !entry.verificationStatus).length;
  const size = `${(bytes / 1024 / 1024).toFixed(0)} MB`;

  if (!entries.length) {
    return [{ id: 'library', label: 'Library', status: 'pass', detail: 'Empty — nothing downloaded yet.', hint: null }];
  }
  if (unchecked) {
    return [
      {
        id: 'library',
        label: 'Library',
        status: 'warn',
        detail: `${entries.length} files · ${size} · ${unchecked} added without a verification record`,
        hint: 'Use Verify a file to check those against a bundle.',
      },
    ];
  }
  return [
    {
      id: 'library',
      label: 'Library',
      status: demo ? 'warn' : 'pass',
      detail: `${entries.length} files · ${size}${demo ? ` · ${demo} demo fixture${demo === 1 ? '' : 's'}` : ''}`,
      hint: demo ? 'Demo fixtures are stand-ins generated offline; delete them when you are done.' : null,
    },
  ];
}

/**
 * Providers: reach each homepage once. A mirror that answers 403 is not down —
 * it is refusing automated requests, which is a different problem with a
 * different fix, so the two are reported differently.
 */
export async function providerChecks(providers: Provider[], timeoutMs = 8_000): Promise<DoctorCheck[]> {
  const results = await Promise.all(
    providers.map(async (provider): Promise<DoctorCheck> => {
      const url =
        provider.id === 'morphe-api'
          ? 'https://api.morphe.software/v2/web-search/com.google.android.youtube~21.43.523~arm64-v8a'
          : provider.homepage;
      try {
        const response = await request(url, { method: 'GET', redirect: 'manual', timeoutMs });
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 403) {
          return {
            id: `provider:${provider.id}`,
            label: provider.label,
            status: 'warn',
            detail: 'Reachable, but refusing automated requests (Cloudflare or geo-block).',
            hint: 'Try again later, or use the browser links in the job log.',
          };
        }
        if (response.status >= 500) {
          return {
            id: `provider:${provider.id}`,
            label: provider.label,
            status: 'warn',
            detail: `Answered HTTP ${response.status}.`,
            hint: 'The source may be down; the others still work.',
          };
        }
        return {
          id: `provider:${provider.id}`,
          label: provider.label,
          status: 'pass',
          detail: `Answered HTTP ${response.status}.`,
          hint: null,
        };
      } catch (error) {
        return {
          id: `provider:${provider.id}`,
          label: provider.label,
          status: 'fail',
          detail: (error as Error).message,
          hint: 'Check this device’s connection; other sources are still tried.',
        };
      }
    }),
  );
  return results;
}

export function settingsChecks(settings: Settings, enabledProviderCount: number): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: 'sources',
    label: 'Sources',
    status: enabledProviderCount === 0 ? 'fail' : enabledProviderCount < 2 ? 'warn' : 'pass',
    detail:
      enabledProviderCount === 0
        ? 'Every source is disabled.'
        : `${enabledProviderCount} source${enabledProviderCount === 1 ? '' : 's'} enabled.`,
    hint: enabledProviderCount < 2 ? 'Keep at least two on: mirrors block each other in turn.' : null,
  });
  checks.push({
    id: 'abi',
    label: 'Preferred ABI',
    status: 'skip',
    detail: settings.preferAbi ? settings.preferAbi : 'Not set — the first variant a mirror lists is used.',
    hint: settings.preferAbi ? null : 'Set it in the Sources tab to get the build your device can install.',
  });
  return checks;
}
