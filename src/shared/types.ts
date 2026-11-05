/** Types shared between the PatchPilot server and the web client. */

export type ApkFileType =
  | 'APK'
  | 'APK_REQUIRED'
  | 'APKM'
  | 'APKS'
  | 'APKS_REQUIRED'
  | 'XAPK'
  | 'XAPK_REQUIRED';

export type FormFactor = 'MOBILE' | 'TV' | 'WATCH' | 'AUTO' | 'UNKNOWN';

export interface BundleConfig {
  id: string;
  name: string;
  kind: 'github' | 'url' | 'upload';
  /** `owner/repo` for GitHub-hosted patch bundles. */
  repo?: string;
  url?: string;
  enabled: boolean;
  builtin: boolean;
}

export interface BundleInfo {
  id: string;
  name: string;
  kind: BundleConfig['kind'];
  repo?: string;
  enabled: boolean;
  builtin: boolean;
  version: string | null;
  patchCount: number;
  packageCount: number;
  fetchedAt: string | null;
  origin: 'network' | 'cache' | 'seed' | 'upload' | null;
  stale: boolean;
  error: string | null;
  downloadUrl: string | null;
}

export interface TargetInfo {
  version: string;
  /** versionCode per ABI, when the bundle pins them. */
  versionCodes: Record<string, number> | null;
  isExperimental: boolean;
  minSdk: number | null;
  patchCount: number;
  patches: string[];
  description: string | null;
}

export interface AppInfo {
  packageName: string;
  name: string;
  iconColor: string | null;
  formFactor: FormFactor;
  fileType: ApkFileType | null;
  /** Every file type the bundles mention for this package. */
  fileTypes: ApkFileType[];
  signatures: string[];
  patchCount: number;
  bundles: { id: string; name: string; patchCount: number }[];
  targets: TargetInfo[];
  /** Version PatchPilot suggests: newest stable target, else newest. */
  recommendedVersion: string | null;
  latestVersion: string | null;
  latestStableVersion: string | null;
  experimentalOnly: boolean;
}

export interface PatchDetail {
  name: string;
  description: string;
  isDefault: boolean;
  category: string | null;
  bundleId: string;
  bundleName: string;
  versions: string[];
  experimentalVersions: string[];
  /** True when the patch is not restricted to particular packages. */
  universal: boolean;
}

export interface AppDetail extends AppInfo {
  patches: PatchDetail[];
}

export interface CatalogResponse {
  apps: AppInfo[];
  bundles: BundleInfo[];
  generatedAt: string;
  appCount: number;
  patchCount: number;
  packageCount: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  homepage: string;
  /** `file` providers hand back a direct download, `page` providers only a web page. */
  kind: 'file' | 'page';
  requiresOptIn: boolean;
  enabled: boolean;
  order: number;
  notes: string[];
}

export type JobStateName = 'queued' | 'resolving' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface JobProviderAttempt {
  providerId: string;
  providerLabel: string;
  status: 'pending' | 'trying' | 'ok' | 'failed' | 'skipped';
  detail: string;
  /** Set when the provider resolved a page the user can open themselves. */
  pageUrl?: string;
  urls?: string[];
  startedAt?: string;
  finishedAt?: string;
}

export interface JobLogLine {
  at: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface DownloadJob {
  id: string;
  state: JobStateName;
  createdAt: string;
  updatedAt: string;
  request: {
    packageName: string;
    appName: string;
    version: string | null;
    versionCodes: Record<string, number> | null;
    fileType: ApkFileType | null;
    signatures: string[];
    providers: string[] | null;
  };
  attempts: JobProviderAttempt[];
  progress: {
    bytesReceived: number;
    bytesTotal: number | null;
    fileName: string | null;
    url: string | null;
    providerId: string | null;
  };
  logs: JobLogLine[];
  error: string | null;
  result: {
    libraryId: string;
    file: ApkFileInfo;
    verification: VerificationResult;
  } | null;
}

export interface ApkFileInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string | null;
  container: 'apk' | 'apkm' | 'xapk' | 'apks' | 'zip' | 'unknown';
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  isSplit: boolean;
  signerSha256: string[];
  signingSchemes: string[];
  metadataSource: 'manifest' | 'bundle-info' | 'unknown';
  warnings: string[];
  /** True for APKs built by PatchPilot's offline demo source. */
  demo?: boolean;
}

export interface VerificationCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
}

export interface VerificationResult {
  status: 'pass' | 'warn' | 'fail';
  file: ApkFileInfo;
  checks: VerificationCheck[];
  summary: string;
}

export interface LibraryEntry {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  packageName: string | null;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  container: ApkFileInfo['container'];
  sha256: string | null;
  signerSha256: string[];
  verificationStatus: VerificationResult['status'] | null;
  providerId: string | null;
  sourceUrl: string | null;
  demo: boolean;
  notes: string | null;
}

export interface ResolveRequest {
  packageName: string;
  version: string | null;
}

export interface ResolveCandidate {
  providerId: string;
  providerLabel: string;
  kind: 'file' | 'page';
  url: string;
  label: string;
  status: 'ok' | 'empty' | 'error';
  detail: string;
}

export interface Settings {
  providers: Record<string, { enabled: boolean; order: number }>;
  /** Ask mirrors to serve the ABI-specific build when the bundle pins version codes. */
  preferAbi: string | null;
  autoRefreshMinutes: number;
  demoSource: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  /** Short commit SHA when the server knows which build it is. */
  commit?: string | null;
  demoSource: boolean;
  dataDir: string;
  libraryDir: string;
  node: string;
  platform: string;
  warnings: string[];
}
