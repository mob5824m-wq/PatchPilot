import type { ApkFileType, FormFactor } from '../../shared/types.ts';

/** A patch bundle target: one supported version of one app. */
export interface Target {
  version: string;
  versionCodes: Record<string, number> | null;
  isExperimental: boolean;
  minSdk: number | null;
  description: string | null;
}

/** What a patch bundle says about one package it can patch. */
export interface Compatibility {
  packageName: string;
  appName: string | null;
  description: string | null;
  fileType: ApkFileType | null;
  iconColor: string | null;
  formFactor: FormFactor;
  signatures: string[];
  targets: Target[];
}

/** A patch, flattened from whichever bundle format it came in. */
export interface Patch {
  name: string;
  description: string;
  isDefault: boolean;
  category: string | null;
  bundleId: string;
  /** Empty for universal patches that name no packages. */
  compatibility: Compatibility[];
  legacyUniversal: boolean;
}

export interface ParsedBundle {
  version: string | null;
  patches: Patch[];
  warnings: string[];
}
