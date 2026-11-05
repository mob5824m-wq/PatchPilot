import type { ProviderInfo, Settings } from '../shared/types.ts';
import { ApkMirrorProvider } from '../server/providers/apkmirror.ts';
import { ApkPureProvider } from '../server/providers/apkpure.ts';
import { FdroidProvider } from '../server/providers/fdroid.ts';
import { GithubReleasesProvider } from '../server/providers/github.ts';
import { MorpheApiProvider } from '../server/providers/morpheApi.ts';
import type { Provider } from '../server/providers/types.ts';

/**
 * The sources the phone can use.
 *
 * Identical to the server's list minus the offline demo provider, which builds
 * fixtures with `node:fs` and has no meaning on a device. Order is the same:
 * the two mirrors that keep old versions first.
 */

const DEFAULT_ORDER = ['apkpure', 'apkmirror', 'fdroid', 'github', 'morphe-api'] as const;

let cached: Provider[] | null = null;

export function appProviders(): Provider[] {
  if (!cached) {
    cached = [
      new ApkPureProvider(),
      new ApkMirrorProvider(),
      new FdroidProvider(),
      new GithubReleasesProvider(),
      new MorpheApiProvider(),
    ];
  }
  return cached;
}

export function providerOrder(provider: Provider, settings: Settings): number {
  const configured = settings.providers[provider.id];
  if (configured) return configured.order;
  const index = (DEFAULT_ORDER as readonly string[]).indexOf(provider.id);
  return (index >= 0 ? index + 1 : 99) * 10;
}

export function isEnabled(provider: Provider, settings: Settings): boolean {
  return settings.providers[provider.id]?.enabled ?? true;
}

export function activeAppProviders(settings: Settings, allow?: string[] | null): Provider[] {
  return appProviders()
    .filter((provider) => isEnabled(provider, settings))
    .filter((provider) => !allow || allow.length === 0 || allow.includes(provider.id))
    .sort((a, b) => providerOrder(a, settings) - providerOrder(b, settings));
}

export function providerStatus(settings: Settings): ProviderInfo[] {
  return appProviders()
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      homepage: provider.homepage,
      kind: provider.kind,
      requiresOptIn: false,
      enabled: isEnabled(provider, settings),
      order: providerOrder(provider, settings),
      notes: provider.notes,
    }))
    .sort((a, b) => a.order - b.order);
}
