/**
 * Where is this UI running?
 *
 * The same bundle serves the desktop app and the Android one. Anything that
 * only makes sense with a device in hand (install an APK, "already saved")
 * checks this rather than guessing from the user agent.
 */

export function isStandalone(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { PatchPilotNative?: unknown }).PatchPilotNative);
}
