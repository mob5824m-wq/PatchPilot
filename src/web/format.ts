export function bytes(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export { fileTypeLabel, stateLabel } from '../shared/labels.ts';

export function appInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/);
  if (!words[0]) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
}

export function iconStyle(color: string | null): Record<string, string> {
  if (!color) return {};
  return {
    background: `color-mix(in srgb, ${color} 22%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
    color,
  };
}
