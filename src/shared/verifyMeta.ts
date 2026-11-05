import type { ApkFileInfo, ApkFileType, VerificationCheck, VerificationResult } from './types.ts';

/**
 * The comparison half of verification: given what a file claims to be and what
 * the patch bundle demands, decide whether Morphe may have it.
 *
 * Deliberately free of filesystem and crypto imports so it runs unchanged in
 * three places: the server (after reading the APK itself), the Android app
 * (after asking PackageManager) and the tests.
 */

type CheckStatus = VerificationCheck['status'];
export type ContainerType = ApkFileInfo['container'];

/** Container type from a file name, without touching node:path so the phone can use it. */
export function containerForFileName(fileName: string): ContainerType {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  switch ((match?.[1] ?? '').toLowerCase()) {
    case 'apk':
      return 'apk';
    case 'apkm':
      return 'apkm';
    case 'xapk':
      return 'xapk';
    case 'apks':
    case 'apksx':
      return 'apks';
    case 'zip':
      return 'zip';
    default:
      return 'unknown';
  }
}

/** What a patch bundle expects of the APK for an app. */
export interface ExpectedApp {
  packageName: string;
  appName?: string;
  versionName?: string | null;
  /** versionCode per ABI, as the patch bundle declares it. */
  versionCodes?: Record<string, number> | number[] | null;
  fileType?: ApkFileType | null;
  signatures?: string[] | null;
  /** The device's own ABI, used to sanity check a bundle's split set. */
  preferAbi?: string | null;
}

function expectedCodes(expected: ExpectedApp): number[] {
  const codes = expected.versionCodes;
  if (!codes) return [];
  if (Array.isArray(codes)) return codes.filter((code) => Number.isFinite(code));
  return Object.values(codes).filter((code) => Number.isFinite(code));
}

function fileTypeSatisfied(expected: ApkFileType | null | undefined, container: ContainerType): CheckStatus {
  if (!expected) return 'skip';
  const isPlainApk = container === 'apk';
  const isBundle = container === 'apkm' || container === 'xapk' || container === 'apks';
  if (container === 'zip' || container === 'unknown') return 'fail';

  switch (expected) {
    case 'APK_REQUIRED':
      return isPlainApk ? 'pass' : 'fail';
    case 'APKS_REQUIRED':
    case 'XAPK_REQUIRED':
      return isBundle ? 'pass' : 'fail';
    case 'APK':
    case 'APKS':
    case 'XAPK':
    case 'APKM':
      return isPlainApk || isBundle ? 'pass' : 'fail';
    default:
      return 'skip';
  }
}

/** `arm64-v8a` and `ARM64_V8A` are the same architecture spelled twice. */
function normalizeAbi(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '_');
}

const ABI_PRIORITY = ['arm64_v8a', 'armeabi_v7a', 'x86_64', 'x86'];

/** Which ABI the bundle cares about, if it says: its own keys win over the device. */
function wantedAbi(expected: ExpectedApp): string | null {
  const declared = Object.keys(expected.versionCodes ?? {}).map(normalizeAbi);
  for (const abi of ABI_PRIORITY) {
    if (declared.includes(abi)) return abi;
  }
  if (declared.length) return declared[0] ?? null;
  return expected.preferAbi ? normalizeAbi(expected.preferAbi) : null;
}

/**
 * A split bundle is only as good as its parts: without a base APK it cannot be
 * installed, and without the split for the device's ABI the patched app will
 * either refuse to start or run unoptimised code.
 */
function splitChecks(file: ApkFileInfo, expected: ExpectedApp, expectedLabel: string): VerificationCheck | null {
  const isBundle = file.container === 'apkm' || file.container === 'xapk' || file.container === 'apks' || file.container === 'zip';
  if (!isBundle) return null;

  const splits = (file.splits ?? []).map((name) => name.toLowerCase());
  if (!splits.length) {
    return {
      id: 'splits',
      label: 'Split contents',
      status: 'skip',
      detail: 'The bundle was not opened, so its split set could not be checked',
    };
  }

  const hasBase = splits.some((name) => /(^|\/)base\.apk$/.test(name));
  if (!hasBase) {
    return {
      id: 'splits',
      label: 'Split contents',
      status: 'fail',
      detail: 'The bundle has no base.apk, so it cannot be installed',
    };
  }

  const abi = wantedAbi(expected);
  if (!abi) {
    return {
      id: 'splits',
      label: 'Split contents',
      status: 'pass',
      detail: `base.apk plus ${splits.length - 1} split${splits.length === 2 ? '' : 's'} (no ABI to check against)`,
    };
  }

  const hasAbi = splits.some((name) => normalizeAbi(name).includes(abi));
  return {
    id: 'splits',
    label: 'Split contents',
    status: hasAbi ? 'pass' : 'warn',
    detail: hasAbi
      ? `base.apk + ${abi} split for ${expectedLabel}`
      : `No ${abi} split in this bundle — the patched app may not start on this device`,
  };
}

function fileTypeHint(expected: ApkFileType): string {
  return expected.startsWith('APKS') || expected.startsWith('XAPK') || expected.startsWith('APKM')
    ? 'a split bundle (.apkm/.xapk/.apks)'
    : 'a single .apk';
}

/**
 * Compares a downloaded file against what a patch bundle declares for an app.
 * Any failure here means the file must not be handed to Morphe.
 */
export function verifyApk(file: ApkFileInfo, expected: ExpectedApp): VerificationResult {
  const checks: VerificationCheck[] = [];
  const expectedLabel = expected.appName ? `${expected.appName} (${expected.packageName})` : expected.packageName;

  checks.push({
    id: 'archive',
    label: 'Readable APK',
    status: file.packageName ? 'pass' : 'fail',
    detail: file.packageName
      ? `${file.container.toUpperCase()} archive with ${file.metadataSource === 'bundle-info' ? 'bundle metadata' : 'a readable manifest'}`
      : 'The file is not a readable APK or split bundle',
  });

  checks.push({
    id: 'package',
    label: 'Package name',
    status: file.packageName === expected.packageName ? 'pass' : file.packageName ? 'fail' : 'fail',
    detail:
      file.packageName === expected.packageName
        ? file.packageName
        : `Expected ${expected.packageName}, found ${file.packageName ?? 'nothing'}`,
  });

  if (expected.versionName) {
    const matches = file.versionName === expected.versionName;
    checks.push({
      id: 'versionName',
      label: 'Version',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `${file.versionName}`
        : `Expected ${expected.versionName}, found ${file.versionName ?? 'unknown'}`,
    });
  } else {
    checks.push({
      id: 'versionName',
      label: 'Version',
      status: 'skip',
      detail: `Bundle does not pin a version for ${expectedLabel}`,
    });
  }

  const codes = expectedCodes(expected);
  const versionMatches = !expected.versionName || file.versionName === expected.versionName;
  if (codes.length && versionMatches) {
    const matches = file.versionCode != null && codes.includes(file.versionCode);
    checks.push({
      id: 'versionCode',
      label: 'Version code',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `${file.versionCode}`
        : `Expected one of ${codes.join(', ')}, found ${file.versionCode ?? 'unknown'}`,
    });
  } else if (codes.length) {
    checks.push({
      id: 'versionCode',
      label: 'Version code',
      status: 'skip',
      detail: `Not checked — the version name did not match`,
    });
  }

  const expectedSignatures = (expected.signatures ?? []).map((value) => value.toLowerCase());
  if (file.demo) {
    // Fixtures are signed with PatchPilot's test key on purpose; saying so is
    // more useful than reporting a mismatch the user cannot act on.
    checks.push({
      id: 'signature',
      label: 'Signing certificate',
      status: 'warn',
      detail: 'Demo fixture — signed with PatchPilot\'s test certificate, not the app developer\'s',
    });
  } else if (expectedSignatures.length) {
    const actual = file.signerSha256.map((value) => value.toLowerCase());
    if (actual.length === 0) {
      checks.push({
        id: 'signature',
        label: 'Signing certificate',
        status: 'warn',
        detail: file.signingSchemes.length
          ? `Signature scheme ${file.signingSchemes.join('/')} present but no certificate could be read`
          : 'No v2/v3 signing block — this APK is v1-only, so its certificate cannot be checked',
      });
    } else {
      const match = actual.some((value) => expectedSignatures.includes(value));
      checks.push({
        id: 'signature',
        label: 'Signing certificate',
        status: match ? 'pass' : 'fail',
        detail: match
          ? `Matches the bundle (${actual[0].slice(0, 16)}…)`
          : `Signed by ${actual[0].slice(0, 16)}…, but the bundle expects ${expectedSignatures[0].slice(0, 16)}… — this is a repack, not the stock app`,
      });
    }
  } else {
    checks.push({
      id: 'signature',
      label: 'Signing certificate',
      status: 'skip',
      detail: 'The patch bundle does not list signing certificates for this package',
    });
  }

  if (expected.fileType) {
    const status = fileTypeSatisfied(expected.fileType, file.container);
    checks.push({
      id: 'fileType',
      label: 'File type',
      status,
      detail:
        status === 'pass'
          ? `${file.container.toUpperCase()} matches what the patches expect (${expected.fileType})`
          : `The patches need ${fileTypeHint(expected.fileType)} (${expected.fileType}), this is ${file.container.toUpperCase()}`,
    });
  }

  const splitCheck = splitChecks(file, expected, expectedLabel);
  if (splitCheck) checks.push(splitCheck);

  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  const status: VerificationResult['status'] = failures.length ? 'fail' : warnings.length ? 'warn' : 'pass';

  const summary = [
    expected.appName ?? file.packageName ?? 'Unknown app',
    file.versionName ?? 'unknown version',
    file.versionCode != null ? `(${file.versionCode})` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return { status, file, checks, summary };
}
