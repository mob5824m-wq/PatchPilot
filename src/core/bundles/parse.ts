import type { ApkFileType, FormFactor } from '../../shared/types.ts';
import type { Compatibility, ParsedBundle, Patch, Target } from './types.ts';

/**
 * Parsers for the `patches-list.json` file every Morphe patch repository
 * publishes at its root (and ships inside its `.mpp` releases).
 *
 * Two shapes exist in the wild:
 *
 *   "compatiblePackages": [
 *     { "packageName": "com.google.android.youtube", "targets": [ … ] }
 *   ]
 *
 *   "compatiblePackages": {
 *     "com.google.android.youtube": ["21.43.523", "21.42.241"]
 *   }
 *
 * The second is the older ReVanced-style map. Both are accepted, and neither is
 * trusted to be complete: anything unreadable is skipped with a warning instead
 * of failing the whole bundle.
 */

const FILE_TYPES: ApkFileType[] = [
  'APK',
  'APK_REQUIRED',
  'APKM',
  'APKS',
  'APKS_REQUIRED',
  'XAPK',
  'XAPK_REQUIRED',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asFormFactor(value: unknown): FormFactor {
  if (typeof value !== 'string') return 'UNKNOWN';
  const upper = value.toUpperCase();
  return upper === 'MOBILE' || upper === 'TV' || upper === 'WATCH' || upper === 'AUTO' ? upper : 'UNKNOWN';
}

export function asFileType(value: unknown): ApkFileType | null {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  return (FILE_TYPES as string[]).includes(upper) ? (upper as ApkFileType) : null;
}

function asVersionCodes(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const codes: Record<string, number> = {};
  for (const [abi, code] of Object.entries(record)) {
    const parsed = asNumber(code);
    if (parsed != null) codes[abi] = parsed;
  }
  return Object.keys(codes).length ? codes : null;
}

function parseTargets(value: unknown, warnings: string[], context: string): Target[] {
  if (!Array.isArray(value)) return [];
  const targets: Target[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const version = asString(record.version);
    if (!version) {
      warnings.push(`${context}: target without a version was skipped`);
      continue;
    }
    targets.push({
      version,
      versionCodes: asVersionCodes(record.versionCodes),
      isExperimental: record.isExperimental === true || record.experimental === true,
      minSdk: asNumber(record.minSdk),
      description: asString(record.description),
    });
  }
  return targets;
}

function parseCompatibilityArray(value: unknown[], warnings: string[], context: string): Compatibility[] {
  const compatibility: Compatibility[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const packageName = asString(record.packageName);
    if (!packageName) {
      warnings.push(`${context}: compatibility entry without a package name was skipped`);
      continue;
    }

    const signatures = Array.isArray(record.signatures)
      ? record.signatures.filter((signature): signature is string => typeof signature === 'string')
      : [];

    compatibility.push({
      packageName,
      appName: asString(record.name),
      description: asString(record.description),
      fileType: asFileType(record.apkFileType),
      iconColor: asString(record.appIconColor),
      formFactor: asFormFactor(record.formFactor),
      signatures,
      targets: parseTargets(record.targets, warnings, context),
    });
  }
  return compatibility;
}

function parseCompatibilityMap(
  value: Record<string, unknown>,
  warnings: string[],
  context: string,
): Compatibility[] {
  const compatibility: Compatibility[] = [];
  for (const [packageName, versions] of Object.entries(value)) {
    if (!Array.isArray(versions)) {
      warnings.push(`${context}: ${packageName} has no version list and was skipped`);
      continue;
    }
    const targets: Target[] = [];
    for (const version of versions) {
      if (typeof version === 'string' && version.length > 0) {
        targets.push({ version, versionCodes: null, isExperimental: false, minSdk: null, description: null });
      }
    }
    compatibility.push({
      packageName,
      appName: null,
      description: null,
      fileType: null,
      iconColor: null,
      formFactor: 'UNKNOWN',
      signatures: [],
      targets,
    });
  }
  return compatibility;
}

export function parsePatchList(json: unknown, bundleId: string): ParsedBundle {
  const warnings: string[] = [];
  const root = asRecord(json);
  if (!root) {
    return { version: null, patches: [], warnings: ['patches-list.json is not a JSON object'] };
  }

  const rawPatches = root.patches;
  if (!Array.isArray(rawPatches)) {
    return { version: null, patches: [], warnings: ['patches-list.json has no "patches" array'] };
  }

  const patches: Patch[] = [];
  let index = 0;
  for (const raw of rawPatches) {
    index += 1;
    const record = asRecord(raw);
    if (!record) continue;
    const name = asString(record.name);
    if (!name) {
      warnings.push(`patch #${index} has no name and was skipped`);
      continue;
    }

    const context = `patch "${name}"`;
    const rawCompatibility = record.compatiblePackages;

    let compatibility: Compatibility[] = [];
    let legacyUniversal = false;
    if (rawCompatibility == null) {
      // No packages listed means the patch applies to anything it is run on.
      legacyUniversal = true;
    } else if (Array.isArray(rawCompatibility)) {
      compatibility = parseCompatibilityArray(rawCompatibility, warnings, context);
    } else {
      const map = asRecord(rawCompatibility);
      if (map) {
        compatibility = parseCompatibilityMap(map, warnings, context);
      } else {
        legacyUniversal = true;
      }
    }

    patches.push({
      name,
      description: asString(record.description) ?? '',
      isDefault: record.default === true || record.use === true,
      category: asString(record.category),
      bundleId,
      compatibility,
      legacyUniversal,
    });
  }

  return { version: asString(root.version), patches, warnings };
}

/** Extracts a version from a `patches-bundle.json` style document. */
export function parseBundleInfo(json: unknown): {
  version: string | null;
  downloadUrl: string | null;
  createdAt: string | null;
} {
  const root = asRecord(json);
  if (!root) return { version: null, downloadUrl: null, createdAt: null };
  return {
    version: asString(root.version),
    downloadUrl: asString(root.download_url),
    createdAt: asString(root.created_at),
  };
}
