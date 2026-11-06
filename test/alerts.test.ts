import assert from 'node:assert/strict';
import test from 'node:test';
import { alertKey, alertMessage, findUpgradeAlerts, newAlerts } from '../src/app/alerts.ts';
import type { AppInfo, LibraryEntry, TargetInfo } from '../src/shared/types.ts';

function target(version: string): TargetInfo {
  return { version, versionCode: null, patches: [{ name: 'Video ads', description: null, compatible: true }] } as unknown as TargetInfo;
}

function app(packageName: string, name: string, versions: string[]): AppInfo {
  return {
    packageName,
    name,
    recommendedVersion: versions.at(-1) ?? null,
    targets: versions.map(target),
  } as unknown as AppInfo;
}

function saved(packageName: string, name: string, versionName: string | null, demo = false): LibraryEntry {
  return {
    id: `${packageName}-${versionName}`,
    fileName: `${packageName}_${versionName}.apk`,
    packageName,
    appName: name,
    versionName,
    demo,
  } as unknown as LibraryEntry;
}

const apps = [
  app('com.google.android.youtube', 'YouTube', ['21.30.216', '21.42.241', '21.43.523']),
  app('com.spotify.music', 'Spotify', ['9.0.10']),
];

test('only something you already saved, and only when a bundle goes newer', () => {
  const alerts = findUpgradeAlerts(
    [
      saved('com.google.android.youtube', 'YouTube', '21.30.216'),
      saved('com.spotify.music', 'Spotify', '9.0.10'), // already the newest patchable
      saved('com.example.gone', 'Gone', '1.0.0'), // no longer in any bundle
      saved('com.google.android.youtube', 'YouTube', null),
    ],
    apps,
  );

  assert.deepEqual(alerts.map((alert) => alert.packageName), ['com.google.android.youtube']);
  assert.equal(alerts[0]?.currentVersion, '21.30.216');
  assert.equal(alerts[0]?.supportedVersion, '21.43.523');
  assert.deepEqual(alerts[0]?.versions, ['21.43.523', '21.42.241']);
});

test('a version newer than everything patchable is not an alert', () => {
  const alerts = findUpgradeAlerts([saved('com.google.android.youtube', 'YouTube', '22.00.000')], apps);
  assert.deepEqual(alerts, []);
});

test('demo fixtures never nag', () => {
  const alerts = findUpgradeAlerts([saved('com.google.android.youtube', 'YouTube', '21.30.216', true)], apps);
  assert.deepEqual(alerts, []);
});

test('each upgrade is announced exactly once', () => {
  const alerts = findUpgradeAlerts([saved('com.google.android.youtube', 'YouTube', '21.30.216')], apps);
  assert.deepEqual(newAlerts(alerts, []), alerts);

  const told = alerts.map(alertKey);
  assert.deepEqual(newAlerts(alerts, told), []);

  // A newer bundle moves the key, so it is worth one more notification.
  const later = findUpgradeAlerts([saved('com.google.android.youtube', 'YouTube', '21.30.216')], [
    app('com.google.android.youtube', 'YouTube', ['21.43.523', '21.50.100']),
  ]);
  assert.deepEqual(newAlerts(later, told).map(alertKey), ['com.google.android.youtube@21.50.100']);
});

test('the notification says what to do, in the user\'s terms', () => {
  const [alert] = findUpgradeAlerts([saved('com.google.android.youtube', 'YouTube', '21.30.216')], apps);
  const message = alertMessage(alert!);
  assert.equal(message.title, 'YouTube 21.43.523 is patchable');
  assert.match(message.body, /You saved 21\.30\.216/);
  assert.match(message.body, /21\.43\.523/);
});
