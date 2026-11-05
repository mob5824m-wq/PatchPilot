import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Small JSON-file store: atomic writes, tolerant reads, no dependencies. */

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
