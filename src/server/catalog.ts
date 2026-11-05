import type {
  ApkFileType,
  AppDetail,
  AppInfo,
  BundleInfo,
  CatalogResponse,
  FormFactor,
  PatchDetail,
  TargetInfo,
} from '../shared/types.ts';
import type { Patch } from './bundles/types.ts';
import { compareVersions, looksExperimental } from './versions.ts';

/**
 * Folds every enabled bundle into one catalog: which apps can be patched, which
 * versions the patches accept, and which version to fetch first.
 */

export interface BundlePayload {
  info: BundleInfo;
  patches: Patch[];
}

interface TargetAccumulator {
  version: string;
  versionCodes: Record<string, number>;
  anyStable: boolean;
  anyExperimental: boolean;
  minSdk: number | null;
  description: string | null;
  patches: Set<string>;
}

interface AppAccumulator {
  packageName: string;
  name: string | null;
  iconColor: string | null;
  formFactor: FormFactor;
  fileTypes: Set<ApkFileType>;
  signatures: Set<string>;
  bundles: Map<string, { name: string; patchCount: number }>;
  targets: Map<string, TargetAccumulator>;
  patches: PatchDetail[];
}

const FILE_TYPE_PRIORITY: ApkFileType[] = [
  'APKS_REQUIRED',
  'XAPK_REQUIRED',
  'APK_REQUIRED',
  'APKS',
  'XAPK',
  'APKM',
  'APK',
];

function strongestFileType(types: Iterable<ApkFileType>): ApkFileType | null {
  const present = new Set(types);
  for (const candidate of FILE_TYPE_PRIORITY) {
    if (present.has(candidate)) return candidate;
  }
  return null;
}

function emptyAccumulator(packageName: string): AppAccumulator {
  return {
    packageName,
    name: null,
    iconColor: null,
    formFactor: 'UNKNOWN',
    fileTypes: new Set(),
    signatures: new Set(),
    bundles: new Map(),
    targets: new Map(),
    patches: [],
  };
}

export function buildCatalog(payloads: BundlePayload[]): CatalogResponse {
  const apps = new Map<string, AppAccumulator>();
  let patchCount = 0;

  for (const { info, patches } of payloads) {
    for (const patch of patches) {
      patchCount += 1;

      if (patch.compatibility.length === 0) {
        // Universal patch: it belongs to no app, so it is not offered per app.
        continue;
      }

      const seenPackages = new Set<string>();
      for (const compatibility of patch.compatibility) {
        const { packageName } = compatibility;
        let app = apps.get(packageName);
        if (!app) {
          app = emptyAccumulator(packageName);
          apps.set(packageName, app);
        }

        if (!app.name && compatibility.appName) app.name = compatibility.appName;
        if (!app.iconColor && compatibility.iconColor) app.iconColor = compatibility.iconColor;
        if (app.formFactor === 'UNKNOWN' && compatibility.formFactor !== 'UNKNOWN') {
          app.formFactor = compatibility.formFactor;
        }
        if (compatibility.fileType) app.fileTypes.add(compatibility.fileType);
        for (const signature of compatibility.signatures) app.signatures.add(signature.toLowerCase());

        const bundleEntry = app.bundles.get(info.id) ?? { name: info.name, patchCount: 0 };
        bundleEntry.patchCount += 1;
        app.bundles.set(info.id, bundleEntry);

        if (!seenPackages.has(packageName)) {
          seenPackages.add(packageName);
          app.patches.push({
            name: patch.name,
            description: patch.description,
            isDefault: patch.isDefault,
            category: patch.category,
            bundleId: info.id,
            bundleName: info.name,
            versions: compatibility.targets.map((target) => target.version),
            experimentalVersions: compatibility.targets
              .filter((target) => target.isExperimental)
              .map((target) => target.version),
            universal: false,
          });
        }

        for (const target of compatibility.targets) {
          let accumulator = app.targets.get(target.version);
          if (!accumulator) {
            accumulator = {
              version: target.version,
              versionCodes: {},
              anyStable: false,
              anyExperimental: false,
              minSdk: null,
              description: null,
              patches: new Set<string>(),
            };
            app.targets.set(target.version, accumulator);
          }
          if (target.versionCodes) {
            for (const [abi, code] of Object.entries(target.versionCodes)) {
              accumulator.versionCodes[abi] ??= code;
            }
          }
          if (target.isExperimental) accumulator.anyExperimental = true;
          else accumulator.anyStable = true;
          if (target.minSdk != null) {
            accumulator.minSdk = accumulator.minSdk == null ? target.minSdk : Math.max(accumulator.minSdk, target.minSdk);
          }
          if (!accumulator.description && target.description) accumulator.description = target.description;
          accumulator.patches.add(`${patch.bundleId}:${patch.name}`);
        }
      }
    }
  }

  const appInfos: AppInfo[] = [];
  for (const app of apps.values()) {
    const targets: TargetInfo[] = [...app.targets.values()]
      .map((target) => ({
        version: target.version,
        versionCodes: Object.keys(target.versionCodes).length ? target.versionCodes : null,
        // A version counts as experimental when no stable patch covers it.
        isExperimental: !target.anyStable && (target.anyExperimental || looksExperimental(target.version)),
        minSdk: target.minSdk,
        patchCount: target.patches.size,
        patches: [...target.patches]
          .map((entry) => entry.slice(entry.indexOf(':') + 1))
          .sort((a, b) => a.localeCompare(b)),
        description: target.description,
      }))
      .sort((a, b) => compareVersions(b.version, a.version));

    const stable = targets.filter((target) => !target.isExperimental);
    const recommended = stable[0] ?? targets[0] ?? null;
    const latest = targets[0] ?? null;
    const fileTypes = [...app.fileTypes];

    appInfos.push({
      packageName: app.packageName,
      name: app.name ?? app.packageName,
      iconColor: app.iconColor,
      formFactor: app.formFactor,
      fileType: strongestFileType(app.fileTypes),
      fileTypes,
      signatures: [...app.signatures],
      patchCount: app.patches.length,
      bundles: [...app.bundles.entries()]
        .map(([id, value]) => ({ id, name: value.name, patchCount: value.patchCount }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      targets,
      recommendedVersion: recommended?.version ?? null,
      latestVersion: latest?.version ?? null,
      latestStableVersion: stable[0]?.version ?? null,
      experimentalOnly: stable.length === 0,
    });

    app.patches.sort((a, b) => a.name.localeCompare(b.name));
  }

  appInfos.sort((a, b) => {
    if (b.patchCount !== a.patchCount) return b.patchCount - a.patchCount;
    return a.name.localeCompare(b.name);
  });

  return {
    apps: appInfos,
    bundles: payloads.map((payload) => payload.info),
    generatedAt: new Date().toISOString(),
    appCount: appInfos.length,
    patchCount,
    packageCount: appInfos.length,
  };
}

export function buildAppDetail(payloads: BundlePayload[], packageName: string): AppDetail | null {
  const catalog = buildCatalog(payloads);
  const app = catalog.apps.find((entry) => entry.packageName === packageName);
  if (!app) return null;

  const patches: PatchDetail[] = [];
  const seen = new Set<string>();
  for (const { info, patches: bundlePatches } of payloads) {
    for (const patch of bundlePatches) {
      const compatibility = patch.compatibility.find((entry) => entry.packageName === packageName);
      if (!compatibility) continue;
      const key = `${info.id}:${patch.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      patches.push({
        name: patch.name,
        description: patch.description,
        isDefault: patch.isDefault,
        category: patch.category,
        bundleId: info.id,
        bundleName: info.name,
        versions: compatibility.targets.map((target) => target.version),
        experimentalVersions: compatibility.targets
          .filter((target) => target.isExperimental)
          .map((target) => target.version),
        universal: false,
      });
    }
  }

  patches.sort((a, b) => a.name.localeCompare(b.name));
  return { ...app, patches };
}
