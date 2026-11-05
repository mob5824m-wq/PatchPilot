import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type {
  ApkFileInfo,
  ApkFileType,
  VerificationCheck,
  VerificationResult,
} from '../../shared/types.ts';
import type { VerificationCheck as Check } from '../../shared/types.ts';

type CheckStatus = Check['status'];
import { parseBinaryManifest, type ManifestInfo } from './axml.ts';
import { readSigningCertificates, type SigningCertificates } from './signblock.ts';
import { ZipReader } from './zip.ts';

export type ContainerType = ApkFileInfo['container'];

export type { ApkFileInfo, VerificationCheck, VerificationResult };
export { verifyApk, type ExpectedApp } from '../../shared/verifyMeta.ts';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INNER_APK_BYTES = 1024 * 1024 * 1024;

export function containerFromName(fileName: string): ContainerType {
  const extension = extname(fileName).toLowerCase();
  switch (extension) {
    case '.apk':
      return 'apk';
    case '.apkm':
      return 'apkm';
    case '.xapk':
      return 'xapk';
    case '.apks':
    case '.apksx':
      return 'apks';
    case '.zip':
      return 'zip';
    default:
      return 'unknown';
  }
}

async function sha256File(path: string, limitBytes = 512 * 1024 * 1024): Promise<string | null> {
  const info = await stat(path);
  if (info.size > limitBytes) return null;
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function findInJson(value: unknown, keys: string[]): string | number | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInJson(item, keys);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key.toLowerCase()) && (typeof child === 'string' || typeof child === 'number')) {
      return child;
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findInJson(child, keys);
    if (found != null) return found;
  }
  return null;
}

interface BundleMetadata {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  source: string;
}

/** APKM and XAPK bundles describe themselves in a small JSON file next to the APKs. */
async function readBundleMetadata(reader: ZipReader): Promise<BundleMetadata | null> {
  const candidates = reader.select((entry) =>
    /^(info\.json|manifest\.json|meta\.json|bundle\.json)$/i.test(entry.name.split('/').pop() ?? ''),
  );
  for (const entry of candidates) {
    if (entry.size > 1024 * 1024) continue;
    try {
      const json = JSON.parse(await reader.readText(entry)) as unknown;
      const packageName = findInJson(json, ['pname', 'package_name', 'packagename', 'package', 'app_package']);
      const versionName = findInJson(json, ['versionname', 'version_name', 'version']);
      const versionCode = findInJson(json, ['versioncode', 'version_code']);
      if (packageName || versionName) {
        return {
          packageName: packageName != null ? String(packageName) : null,
          versionName: versionName != null ? String(versionName) : null,
          versionCode: versionCode != null ? Number(versionCode) || null : null,
          source: entry.name,
        };
      }
    } catch {
      // Ignore unreadable metadata and fall back to the inner APK's manifest.
    }
  }
  return null;
}

/** Picks the base APK out of a split bundle. */
function pickBaseEntry(reader: ZipReader): string | null {
  const apks = reader.select((entry) => entry.name.toLowerCase().endsWith('.apk'));
  const base =
    apks.find((entry) => entry.name.split('/').pop()?.toLowerCase() === 'base.apk') ??
    apks.find((entry) => /(^|\/)base-[a-z]+\.apk$/i.test(entry.name)) ??
    apks.find((entry) => entry.name.split('/').length === 1);
  return base?.name ?? null;
}

/** Reads a plain APK from disk (or an extracted inner base APK). */
async function inspectPlainApk(
  path: string,
  container: ContainerType,
  warnings: string[],
): Promise<{
  manifest: ManifestInfo | null;
  signing: SigningCertificates | null;
  isSplit: boolean;
}> {
  const reader = await ZipReader.open(path);
  try {
    let manifest: ManifestInfo | null = null;
    const manifestEntry = reader.find('AndroidManifest.xml');
    if (!manifestEntry) {
      warnings.push('No AndroidManifest.xml found — the file is not a valid APK');
    } else if (manifestEntry.size > MAX_MANIFEST_BYTES) {
      warnings.push('AndroidManifest.xml is implausibly large, skipping it');
    } else {
      const raw = await reader.read(manifestEntry);
      manifest = parseBinaryManifest(raw);
      warnings.push(...manifest.warnings);
    }

    const isSplit =
      container === 'apkm' || container === 'xapk' || container === 'apks'
        ? true
        : (manifest?.isSplitRequired ?? false);

    const signing = await readSigningCertificates(path);
    return { manifest, signing, isSplit };
  } finally {
    await reader.close();
  }
}

/**
 * Reads package, version and signing information out of an APK or a split
 * bundle (`.apkm`, `.xapk`, `.apks`).
 */
export async function describeApk(path: string): Promise<ApkFileInfo> {
  const info = await stat(path);
  const fileName = basename(path);
  const warnings: string[] = [];
  let container = containerFromName(fileName);
  if (container === 'unknown' || container === 'zip') container = 'zip';

  const reader = await ZipReader.open(path);
  let manifest: ManifestInfo | null = null;
  let signing: SigningCertificates | null = null;
  let metadataSource: ApkFileInfo['metadataSource'] = 'unknown';
  let packageName: string | null = null;
  let versionName: string | null = null;
  let versionCode: number | null = null;
  let isSplit = false;

  try {
    const names = reader.entries.map((entry) => entry.name);
    const hasManifest = names.includes('AndroidManifest.xml');
    if (hasManifest) {
      const raw = await reader.read('AndroidManifest.xml', MAX_MANIFEST_BYTES);
      manifest = parseBinaryManifest(raw);
      warnings.push(...manifest.warnings);
      metadataSource = 'manifest';
      signing = await readSigningCertificates(path);
      isSplit = manifest.isSplitRequired;
    } else {
      // A split bundle: describe it from its metadata, then from its base APK.
      container = container === 'zip' ? 'apkm' : container;
      const metadata = await readBundleMetadata(reader);
      if (metadata) {
        packageName = metadata.packageName;
        versionName = metadata.versionName;
        versionCode = metadata.versionCode;
        metadataSource = 'bundle-info';
      }

      const baseEntry = pickBaseEntry(reader);
      if (baseEntry) {
        const entry = reader.find(baseEntry)!;
        if (entry.size <= MAX_INNER_APK_BYTES) {
          const tempDir = await mkdtemp(join(tmpdir(), 'patchpilot-base-'));
          const tempPath = join(tempDir, 'base.apk');
          try {
            await writeFile(tempPath, await reader.read(entry, MAX_INNER_APK_BYTES));
            const inner = await inspectPlainApk(tempPath, container, warnings);
            if (inner.manifest) {
              manifest = inner.manifest;
              packageName = packageName ?? inner.manifest.packageName;
              versionName = versionName ?? inner.manifest.versionName;
              versionCode = versionCode ?? inner.manifest.versionCode;
              if (metadataSource === 'unknown') metadataSource = 'manifest';
            }
            signing = inner.signing;
            isSplit = true;
          } finally {
            await rm(tempDir, { recursive: true, force: true });
          }
        } else {
          warnings.push(`Base APK inside the bundle is too large to inspect (${entry.size} bytes)`);
        }
      } else {
        warnings.push('No base APK found inside the bundle');
      }
    }
  } finally {
    await reader.close();
  }

  const signerSha256 = signing ? [...new Set([...signing.v2, ...signing.v3])] : [];
  const signingSchemes: string[] = [];
  if (signing?.v2.length) signingSchemes.push('v2');
  if (signing?.v3.length) signingSchemes.push('v3');
  if (signing?.warnings.length) warnings.push(...signing.warnings);

  return {
    path,
    fileName,
    sizeBytes: info.size,
    sha256: await sha256File(path),
    container,
    packageName: packageName ?? manifest?.packageName ?? null,
    versionName: versionName ?? manifest?.versionName ?? null,
    versionCode: versionCode ?? manifest?.versionCode ?? null,
    minSdk: manifest?.minSdk ?? null,
    targetSdk: manifest?.targetSdk ?? null,
    isSplit,
    signerSha256,
    signingSchemes,
    metadataSource,
    warnings,
  };
}
