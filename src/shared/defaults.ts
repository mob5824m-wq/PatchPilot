import type { BundleConfig, Settings } from './types.ts';

/**
 * Shipped defaults, shared by the Node server and the Android app so both start
 * from the same bundles and the same source order.
 */

export const defaultBundles: BundleConfig[] = [
  {
    id: 'morphe-official',
    name: 'Morphe Patches',
    kind: 'github',
    repo: 'MorpheApp/morphe-patches',
    enabled: true,
    builtin: true,
  },
  {
    id: 'hxreborn',
    name: 'hxreborn patches',
    kind: 'github',
    repo: 'hxreborn/morphe-patches',
    enabled: true,
    builtin: true,
  },
  {
    id: 'piko',
    name: 'Piko (Twitter/X & Instagram)',
    kind: 'github',
    repo: 'crimera/piko',
    enabled: true,
    builtin: true,
  },
];

export const defaultSettings: Settings = {
  providers: {},
  preferAbi: null,
  autoRefreshMinutes: 180,
  demoSource: false,
};
