/**
 * Which ABI to ask the mirrors for.
 *
 * Patch bundles pin a version code per ABI, and mirrors serve a different
 * variant per ABI, so a phone that says "arm64-v8a" gets the build it can
 * actually install instead of whatever the mirror lists first.
 */

/** Ordered by how likely a device is to be able to use it. */
const PREFERRED = ['arm64-v8a', 'armeabi-v7a', 'arm64-v8a,armeabi-v7a', 'x86_64', 'x86'];

export function abiPreference(supportedAbis: string[] | null | undefined): string | null {
  if (!supportedAbis?.length) return null;
  for (const abi of PREFERRED) {
    const match = supportedAbis.map((value) => value.trim().toLowerCase()).find((value) => value === abi);
    if (match) return match;
  }
  // Fall back to whatever the platform listed first, as long as it looks like
  // an ABI rather than a placeholder.
  const first = supportedAbis[0]?.trim().toLowerCase();
  return first && first.length > 2 ? first : null;
}
