/** Human labels shared by the web UI and the CLI. */

export function fileTypeLabel(fileType: string | null): string {
  if (!fileType) return 'any file';
  const map: Record<string, string> = {
    APK: 'single .apk (or bundle)',
    APK_REQUIRED: 'single .apk',
    APKM: '.apkm bundle',
    APKS: '.apks bundle',
    APKS_REQUIRED: '.apks split bundle',
    XAPK: '.xapk bundle',
    XAPK_REQUIRED: '.xapk split bundle',
  };
  return map[fileType] ?? fileType;
}

export function stateLabel(state: string): string {
  const map: Record<string, string> = {
    queued: 'Queued',
    resolving: 'Asking sources',
    downloading: 'Downloading',
    verifying: 'Verifying',
    done: 'Done',
    failed: 'No luck',
    cancelled: 'Cancelled',
  };
  return map[state] ?? state;
}
