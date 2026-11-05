/** Helpers for reading undocumented JSON without trusting its exact shape. */

export function walkObjects(value: unknown, visit: (record: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    visit(record);
    for (const child of Object.values(record)) walkObjects(child, visit, depth + 1);
  }
}

export function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** Every string in the document that looks like a package download URL. */
export function collectUrls(value: unknown): string[] {
  const urls = new Set<string>();
  walkObjects(value, (record) => {
    for (const child of Object.values(record)) {
      if (typeof child === 'string' && /^https?:\/\//.test(child) && /\.(apk|apkm|apks|xapk)(\?|$)/i.test(child)) {
        urls.add(child);
      }
    }
  });
  return [...urls];
}
