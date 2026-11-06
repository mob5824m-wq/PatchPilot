import type { AppInfo, LibraryEntry } from '../shared/types.ts';
import { compareVersions } from '../core/versions.ts';

/**
 * "A newer version of something you already downloaded is patchable now."
 *
 * The catalogue is what the loaded bundles support; the library is what the user
 * already fetched. When those two drift — a bundle update, or an app you saved
 * months ago — the difference is worth one notification, and only one per app
 * and version.
 */

export interface UpgradeAlert {
  packageName: string;
  appName: string;
  /** What is in the library. */
  currentVersion: string;
  /** What the loaded bundles would accept instead. */
  supportedVersion: string;
  /** Every version this app could be updated to, newest first. */
  versions: string[];
}

export function findUpgradeAlerts(entries: LibraryEntry[], apps: AppInfo[]): UpgradeAlert[] {
  const byPackage = new Map(apps.map((app) => [app.packageName, app]));

  const alerts: UpgradeAlert[] = [];
  for (const entry of entries) {
    const current = entry.versionName;
    if (entry.demo || !current || !entry.packageName) continue;
    const app = byPackage.get(entry.packageName);
    if (!app) continue;

    const versions = app.targets
      .map((target) => target.version)
      .filter((version) => compareVersions(version, current) > 0)
      .sort((a, b) => compareVersions(b, a));
    if (!versions.length) continue;

    alerts.push({
      packageName: entry.packageName,
      appName: app.name,
      currentVersion: current,
      supportedVersion: versions[0]!,
      versions,
    });
  }

  return alerts.sort((a, b) => a.appName.localeCompare(b.appName));
}

/** The key a notification is de-duplicated by. */
export function alertKey(alert: UpgradeAlert): string {
  return `${alert.packageName}@${alert.supportedVersion}`;
}

/** Alerts the user has not already been told about. */
export function newAlerts(alerts: UpgradeAlert[], alreadyTold: string[]): UpgradeAlert[] {
  const told = new Set(alreadyTold);
  return alerts.filter((alert) => !told.has(alertKey(alert)));
}

export function alertMessage(alert: UpgradeAlert): { title: string; body: string } {
  return {
    title: `${alert.appName} ${alert.supportedVersion} is patchable`,
    body: `You saved ${alert.currentVersion}. Your loaded bundles now accept ${alert.supportedVersion} — open PatchPilot to fetch it.`,
  };
}
