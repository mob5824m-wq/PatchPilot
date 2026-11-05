import type { ApkFileType } from '../../shared/types.ts';

export interface ResolveContext {
  packageName: string;
  appName: string;
  versionName: string | null;
  versionCodes: Record<string, number> | null;
  fileType: ApkFileType | null;
  /** ABI to prefer when a bundle pins per-ABI version codes. */
  preferAbi: string | null;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface CandidateFile {
  url: string;
  label: string;
  /** Set instead of `url` for providers that produce a file locally (the demo source). */
  localPath?: string;
  headers?: Record<string, string>;
  /** Extra hint used to sanity check the version code before the full verification. */
  expectedVersionCode?: number | null;
}

export interface CandidatePage {
  url: string;
  label: string;
}

export interface ProviderResult {
  files: CandidateFile[];
  pages: CandidatePage[];
  /** One-line description of what happened, shown in the job log. */
  detail: string;
}

export interface ProviderMeta {
  id: string;
  label: string;
  description: string;
  homepage: string;
  kind: 'file' | 'page';
  notes: string[];
}

export interface Provider extends ProviderMeta {
  resolve(context: ResolveContext): Promise<ProviderResult>;
}

export function emptyResult(detail: string): ProviderResult {
  return { files: [], pages: [], detail };
}
