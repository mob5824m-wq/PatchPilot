import type { ApkFileInfo, LibraryEntry, VerificationResult } from '../shared/types.ts';
import { containerForFileName } from '../shared/verifyMeta.ts';
import type { Native, NativeApkInfo, NativeLibraryFile } from './native.ts';

/**
 * The library on the phone.
 *
 * The files themselves live in `Downloads/PatchPilot`, because that is the
 * folder Morphe Manager's picker can browse. The shell owns them; this class
 * keeps a small index (package, version, verification result) in the key-value
 * store so the list keeps its meaning after a restart, and reconciles that index
 * against what is really on disk every time it is read.
 */

const STORE_KEY = 'library.v1';

interface StoredEntry extends LibraryEntry {
  handle: string;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'app';
}

export function libraryFileName(file: { packageName: string | null; versionName: string | null; container: string; demo?: boolean }, extension: string, appName: string | null): string {
  const app = sanitize(file.packageName ?? appName ?? 'app');
  const version = sanitize(file.versionName ?? 'unknown');
  const split = file.container !== 'apk' ? `-${file.container}` : '';
  const demo = file.demo ? '-DEMO' : '';
  return `${app}_${version}${split}${demo}${extension}`;
}

/** Recovers package and version from a library file name, for files the index lost. */
function guessFromName(name: string): { packageName: string | null; versionName: string | null } {
  const base = name.replace(/\.(apk|apkm|xapk|apks|zip)$/i, '');
  const match = /^(.+?)_([^_]+?)(?:-(?:apkm|xapk|apks))?(?:-DEMO)?(?:-\d+)?$/.exec(base);
  if (!match) return { packageName: null, versionName: null };
  return { packageName: match[1] ?? null, versionName: match[2] ?? null };
}

export function toApkFileInfo(observed: NativeApkInfo, fileName: string, handle: string): ApkFileInfo {
  return {
    path: handle,
    fileName,
    sizeBytes: observed.sizeBytes,
    sha256: null,
    container: containerForFileName(fileName),
    packageName: observed.packageName,
    versionName: observed.versionName,
    versionCode: observed.versionCode,
    minSdk: observed.minSdk ?? null,
    targetSdk: observed.targetSdk ?? null,
    isSplit: observed.isSplit,
    signerSha256: observed.signerSha256 ?? [],
    signingSchemes: observed.signingSchemes ?? [],
    metadataSource: observed.packageName ? 'manifest' : 'unknown',
    warnings: [],
  };
}

export interface AddOptions {
  file: ApkFileInfo;
  /** Where the shell left the downloaded bytes; deleted if publishing fails. */
  tempPath: string;
  verification: VerificationResult;
  appName: string | null;
  providerId: string | null;
  sourceUrl: string | null;
  notes?: string | null;
}

export class LocalLibrary {
  private entries = new Map<string, StoredEntry>();

  constructor(private readonly native: Native) {}

  async init(): Promise<void> {
    try {
      const raw = await this.native.getStore(STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredEntry[];
      for (const entry of parsed) this.entries.set(entry.id, entry);
    } catch {
      // A corrupt index is not worth failing the app over; the files are the truth.
    }
  }

  async add(options: AddOptions): Promise<LibraryEntry> {
    const extension = /\.(apk|apkm|xapk|apks|zip)$/i.exec(options.file.fileName)?.[0] ?? `.${options.file.container}`;
    const fileName = libraryFileName(options.file, extension, options.appName);

    const published: NativeLibraryFile = await this.native.publish(options.tempPath, fileName);
    const entry: StoredEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: published.name,
      sizeBytes: published.sizeBytes,
      createdAt: new Date().toISOString(),
      packageName: options.file.packageName,
      appName: options.appName,
      versionName: options.file.versionName,
      versionCode: options.file.versionCode,
      container: options.file.container,
      sha256: options.file.sha256,
      signerSha256: options.file.signerSha256,
      verificationStatus: options.verification.status,
      providerId: options.providerId,
      sourceUrl: options.sourceUrl,
      demo: options.file.demo === true,
      notes: options.notes ?? null,
      handle: published.handle,
    };

    this.entries.set(entry.id, entry);
    await this.persist();
    return this.withoutHandle(entry);
  }

  async list(): Promise<LibraryEntry[]> {
    const files = await this.native.listLibrary().catch(() => [] as NativeLibraryFile[]);
    const byName = new Map(files.map((file) => [file.name, file]));
    let changed = false;

    // Drop entries whose file is gone.
    for (const [id, entry] of [...this.entries]) {
      const file = byName.get(entry.fileName);
      if (!file) {
        this.entries.delete(id);
        changed = true;
        continue;
      }
      if (entry.sizeBytes !== file.sizeBytes || entry.handle !== file.handle) {
        entry.sizeBytes = file.sizeBytes;
        entry.handle = file.handle;
        changed = true;
      }
    }

    // Adopt files the index never saw (for example after an app reinstall).
    const known = new Set([...this.entries.values()].map((entry) => entry.fileName));
    for (const file of files) {
      if (known.has(file.name)) continue;
      const guess = guessFromName(file.name);
      this.entries.set(`file-${file.name}`, {
        id: `file-${file.name}`,
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        createdAt: file.modifiedAt,
        packageName: guess.packageName,
        appName: null,
        versionName: guess.versionName,
        versionCode: null,
        container: containerForFileName(file.name),
        sha256: null,
        signerSha256: [],
        verificationStatus: null,
        providerId: null,
        sourceUrl: null,
        demo: /-DEMO\./.test(file.name),
        notes: 'Found in Downloads/PatchPilot — not downloaded by this install',
        handle: file.handle,
      });
      changed = true;
    }

    if (changed) await this.persist();
    return [...this.entries.values()]
      .map((entry) => this.withoutHandle(entry))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    await this.native.deleteLibraryFile(entry.handle).catch(() => false);
    this.entries.delete(id);
    await this.persist();
    return true;
  }

  async describe(id: string): Promise<{ file: ApkFileInfo; entry: LibraryEntry } | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const observed = await this.native.inspect(entry.handle);
    return { file: toApkFileInfo(observed, entry.fileName, entry.handle), entry: this.withoutHandle(entry) };
  }

  private withoutHandle(entry: StoredEntry): LibraryEntry {
    const { handle, ...rest } = entry;
    void handle;
    return rest;
  }

  private async persist(): Promise<void> {
    try {
      await this.native.setStore(STORE_KEY, JSON.stringify([...this.entries.values()]));
    } catch {
      // Best effort, like bundles.
    }
  }
}
