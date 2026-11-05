import type { BundleConfig, Settings } from './types.ts';

/**
 * Shipped defaults, shared by the Node server and the Android app so both start
 * from the same bundles and the same source order.
 *
 * The three below are *offered*, not loaded: PatchPilot only offers the versions
 * a bundle names, so switching on a bundle you do not use in Morphe would offer
 * apps you cannot patch. Nothing is enabled until the user says which bundles
 * their Morphe has (Sources → Import from Morphe, or the toggle).
 */

export const defaultBundles: BundleConfig[] = [
  {
    id: 'morphe-official',
    name: 'Morphe Patches',
    kind: 'github',
    repo: 'MorpheApp/morphe-patches',
    enabled: false,
    builtin: true,
  },
  {
    id: 'hxreborn',
    name: 'hxreborn patches',
    kind: 'github',
    repo: 'hxreborn/morphe-patches',
    enabled: false,
    builtin: true,
  },
  {
    id: 'piko',
    name: 'Piko (Twitter/X & Instagram)',
    kind: 'github',
    repo: 'crimera/piko',
    enabled: false,
    builtin: true,
  },
];

export const defaultSettings: Settings = {
  providers: {},
  preferAbi: null,
  autoRefreshMinutes: 180,
  demoSource: false,
};

/**
 * A private copy of the shipped bundles.
 *
 * Defaults are module-level constants, and callers mutate what they adopt
 * (`config.enabled = true`). Copying here is the difference between "the user
 * loaded this bundle" and "every store in this process now thinks so".
 */
export function cloneDefaultBundles(): BundleConfig[] {
  return defaultBundles.map((bundle) => ({ ...bundle }));
}
