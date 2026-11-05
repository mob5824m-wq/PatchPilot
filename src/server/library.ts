import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import type { ApkFileInfo, LibraryEntry, VerificationResult } from '../shared/types.ts';
import { libraryDir, paths } from './config.ts';
import { readJson, writeJson } from './store.ts';

/**
 * The library is the folder Morphe's file picker points at: every APK that passed
 * verification, filed under a predictable name.
 */

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'app';
}

function targetFileName(file: ApkFileInfo, appName: string | null): string {
  const extension = extname(file.fileName) || `.${file.container}`;
  const app = sanitize(file.packageName ?? appName ?? 'app');
  const version = sanitize(file.versionName ?? 'unknown');
  const split = file.container !== 'apk' ? `-${file.container}` : '';
  const demo = file.demo ? '-DEMO' : '';
  return `${app}_${version}${split}${demo}${extension}`;
}

async function uniquePath(directory: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const base = basename(fileName, extension);
  let candidate = join(directory, fileName);
  let counter = 1;
  for (;;) {
    try {
      await stat(candidate);
      counter += 1;
      candidate = join(directory, `${base}-${counter}${extension}`);
    } catch {
      return candidate;
    }
  }
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const entries = await readJson<LibraryEntry[]>(paths.libraryIndex, []);
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function saveIndex(entries: LibraryEntry[]): Promise<void> {
  await writeJson(paths.libraryIndex, entries);
}

export interface AddToLibraryOptions {
  file: ApkFileInfo;
  verification: VerificationResult | null;
  appName: string | null;
  providerId: string | null;
  sourceUrl: string | null;
  notes?: string | null;
}

/** Moves a verified download into the library and records it. */
export async function addToLibrary(options: AddToLibraryOptions): Promise<LibraryEntry> {
  await mkdir(libraryDir, { recursive: true });
  const finalPath = await uniquePath(libraryDir, targetFileName(options.file, options.appName));
  await rename(options.file.path, finalPath).catch(async () => {
    await copyFile(options.file.path, finalPath);
    await unlink(options.file.path).catch(() => undefined);
  });

  const entry: LibraryEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: basename(finalPath),
    sizeBytes: options.file.sizeBytes,
    createdAt: new Date().toISOString(),
    packageName: options.file.packageName,
    appName: options.appName,
    versionName: options.file.versionName,
    versionCode: options.file.versionCode,
    container: options.file.container,
    sha256: options.file.sha256,
    signerSha256: options.file.signerSha256,
    verificationStatus: options.verification?.status ?? null,
    providerId: options.providerId,
    sourceUrl: options.sourceUrl,
    demo: options.file.demo === true,
    notes: options.notes ?? null,
  };

  const entries = await readJson<LibraryEntry[]>(paths.libraryIndex, []);
  entries.push(entry);
  await saveIndex(entries);
  return entry;
}

export async function libraryFilePath(id: string): Promise<string | null> {
  const entries = await readJson<LibraryEntry[]>(paths.libraryIndex, []);
  const entry = entries.find((item) => item.id === id);
  if (!entry) return null;
  return join(libraryDir, basename(entry.fileName));
}

export async function removeFromLibrary(id: string): Promise<boolean> {
  const entries = await readJson<LibraryEntry[]>(paths.libraryIndex, []);
  const entry = entries.find((item) => item.id === id);
  if (!entry) return false;
  await rm(join(libraryDir, basename(entry.fileName)), { force: true });
  await saveIndex(entries.filter((item) => item.id !== id));
  return true;
}

/** Re-inspects every library file, so the list reflects what is actually on disk. */
export async function pruneLibrary(): Promise<LibraryEntry[]> {
  const entries = await readJson<LibraryEntry[]>(paths.libraryIndex, []);
  const present = new Set(await readdir(libraryDir).catch(() => [] as string[]));
  const kept = entries.filter((entry) => present.has(basename(entry.fileName)));
  if (kept.length !== entries.length) await saveIndex(kept);
  return kept;
}

export function libraryReadStream(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}
