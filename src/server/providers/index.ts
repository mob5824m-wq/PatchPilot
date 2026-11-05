import type { ProviderInfo, Settings } from '../../shared/types.ts';
import { request } from '../http.ts';
import { ApkMirrorProvider } from './apkmirror.ts';
import { ApkPureProvider } from './apkpure.ts';
import { DemoProvider } from './demo.ts';
import { FdroidProvider } from './fdroid.ts';
import { GithubReleasesProvider } from './github.ts';
import { MorpheApiProvider } from './morpheApi.ts';
import type { Provider } from './types.ts';

/**
 * Provider order is the order PatchPilot tries them in: sources that can hand
 * back an exact file first, scraped mirrors after, and the human-facing Morphe
 * helper last. Users can reorder or disable any of them.
 */

const DEFAULT_ORDER = ['fdroid', 'github', 'apkpure', 'apkmirror', 'morphe-api', 'demo'] as const;

export function allProviders(): Provider[] {
  return [
    new FdroidProvider(),
    new GithubReleasesProvider(),
    new ApkPureProvider(),
    new ApkMirrorProvider(),
    new MorpheApiProvider(),
    new DemoProvider(),
  ];
}

function orderFor(provider: Provider, settings: Settings): number {
  const configured = settings.providers[provider.id];
  if (configured) return configured.order;
  const index = (DEFAULT_ORDER as readonly string[]).indexOf(provider.id);
  return (index >= 0 ? index + 1 : 99) * 10;
}

function enabledFor(provider: Provider, settings: Settings): boolean {
  if (provider.id === 'demo') return settings.demoSource;
  const configured = settings.providers[provider.id];
  return configured ? configured.enabled : true;
}

export function providerStatus(settings: Settings): ProviderInfo[] {
  return allProviders()
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      homepage: provider.homepage,
      kind: provider.kind,
      requiresOptIn: false,
      enabled: enabledFor(provider, settings),
      order: orderFor(provider, settings),
      notes: provider.notes,
    }))
    .sort((a, b) => a.order - b.order);
}

/** Providers to try for a job, in order, honouring explicit allow-lists. */
export function activeProviders(settings: Settings, allow?: string[] | null): Provider[] {
  return allProviders()
    .filter((provider) => enabledFor(provider, settings))
    .filter((provider) => !allow || allow.length === 0 || allow.includes(provider.id))
    .sort((a, b) => orderFor(a, settings) - orderFor(b, settings));
}

export interface ProbeResult {
  id: string;
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
  detail: string;
}

/** Cheap reachability check used by the Sources screen. */
export async function probeProvider(id: string): Promise<ProbeResult> {
  const provider = allProviders().find((entry) => entry.id === id);
  if (!provider) return { id, reachable: false, status: null, latencyMs: null, detail: 'Unknown provider' };

  const target =
    provider.id === 'morphe-api'
      ? 'https://api.morphe.software/v2/web-search/com.google.android.youtube~21.43.523~arm64-v8a'
      : provider.homepage;

  const started = Date.now();
  try {
    const response = await request(target, { method: 'GET', redirect: 'manual', timeoutMs: 10_000 });
    await response.body?.cancel().catch(() => undefined);
    return {
      id,
      reachable: response.status < 500,
      status: response.status,
      latencyMs: Date.now() - started,
      detail:
        response.status === 403
          ? 'Reachable, but refusing automated requests (Cloudflare or geo-block).'
          : response.status < 400 || response.status < 500
            ? `Answered HTTP ${response.status} in ${Date.now() - started} ms.`
            : `Answered HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      id,
      reachable: false,
      status: null,
      latencyMs: Date.now() - started,
      detail: (error as Error).message,
    };
  }
}
