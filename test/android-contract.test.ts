import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The bridge between TypeScript and Java is a list of strings, and nothing in
 * either compiler checks it. These tests do: they read both sides and fail when
 * the two drift, which is the one class of Android bug that a Gradle build on
 * someone else's machine is too late to catch.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const javaDir = join(root, 'android', 'app', 'src', 'main', 'java', 'app', 'patchpilot');
const nativeShell = readFileSync(join(javaDir, 'NativeShell.java'), 'utf8');
const nativeTs = readFileSync(join(root, 'src', 'app', 'native.ts'), 'utf8');
const manifest = readFileSync(join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const strings = readFileSync(join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle.kts'), 'utf8');

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

test('every action the page calls exists in the shell, and vice versa', () => {
  // Actions dispatched from the switch, plus the ones a constant names because
  // they are answered later (the folder picker waits for its activity result).
  const implemented = new Set([
    ...matches(nativeShell, /case\s+"([^"]+)":/g),
    ...matches(nativeShell, /static final String ACTION_[A-Z_]+\s*=\s*"([^"]+)"/g),
  ]);
  const used = new Set(matches(nativeTs, /this\.bridge\.call\(\s*'([^']+)'/g));

  assert.ok(used.size >= 10, `expected the full action list, found ${used.size}`);
  assert.deepEqual(
    [...used].sort(),
    [...implemented].sort(),
    'NativeShell and src/app/native.ts disagree about the available actions',
  );
});

test('the shell reports every device field the page reads', () => {
  const reported = new Set(matches(nativeShell, /device\.put\("([^"]+)"/g));
  for (const field of ['version', 'sdk', 'model', 'abis']) {
    assert.ok(reported.has(field), `deviceJson() does not report ${field}`);
    assert.ok(new RegExp(`\\b${field}\\??:`).test(nativeTs), `NativeDevice is missing ${field}`);
  }
});

test('every component named in the manifest has a class', () => {
  const components = matches(manifest, /android:name="\.([A-Za-z0-9_]+)"/g);
  assert.ok(components.length >= 2, 'the manifest should declare an activity and a service');
  for (const component of components) {
    assert.ok(existsSync(join(javaDir, `${component}.java`)), `${component} is declared but missing`);
  }
});

test('every string resource the Java uses is defined', () => {
  const defined = new Set(matches(strings, /<string name="([^"]+)"/g));
  const javaSources = ['MainActivity.java', 'NativeShell.java', 'DownloadService.java', 'LibraryStore.java'];
  for (const file of javaSources) {
    const source = readFileSync(join(javaDir, file), 'utf8');
    for (const name of matches(source, /R\.string\.([A-Za-z0-9_]+)/g)) {
      assert.ok(defined.has(name), `${file} uses R.string.${name}, which is not in strings.xml`);
    }
  }
  // The manifest's label counts too.
  for (const name of matches(manifest, /@string\/([A-Za-z0-9_]+)/g)) {
    assert.ok(defined.has(name), `the manifest references @string/${name}, which is not defined`);
  }
});

test('the Java package, the Gradle namespace and the app id agree', () => {
  assert.match(gradle, /namespace\s*=\s*"app\.patchpilot"/);
  assert.match(gradle, /applicationId\s*=\s*"app\.patchpilot"/);
  for (const file of ['MainActivity.java', 'NativeShell.java']) {
    const source = readFileSync(join(javaDir, file), 'utf8');
    assert.match(source, /^package app\.patchpilot;/m, `${file} is in the wrong package`);
  }
});

test('the APK ships the web UI, and both sides agree on the bridge name', () => {
  assert.match(gradle, /src\/main\/assets\/web/);
  assert.match(gradle, /dist\/web/);
  assert.match(gradle, /preBuild/);

  const mainActivity = readFileSync(join(javaDir, 'MainActivity.java'), 'utf8');
  assert.match(mainActivity, /addJavascriptInterface\(shell, "PatchPilotNative"\)/);
  assert.match(nativeTs, /PatchPilotNative/);
  assert.match(nativeTs, /__patchpilotBridge/);
  assert.match(nativeShell, /__patchpilotBridge/);
});

test('the launcher icon is declared and every file it needs exists', () => {
  const resDir = join(root, 'android', 'app', 'src', 'main', 'res');

  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);

  // Android 8+ takes the adaptive icon; the PNGs below it cover 7.x, which this
  // app still supports (minSdk 24).
  const adaptive = readFileSync(join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8');
  assert.match(adaptive, /<background android:drawable="@drawable\/ic_launcher_background"/);
  assert.match(adaptive, /<foreground android:drawable="@drawable\/ic_launcher_foreground"/);
  assert.match(adaptive, /<monochrome android:drawable="@drawable\/ic_launcher_foreground"/);
  assert.ok(existsSync(join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml')));

  const foreground = readFileSync(join(resDir, 'drawable', 'ic_launcher_foreground.xml'), 'utf8');
  assert.match(foreground, /android:viewportWidth="108"/);
  assert.ok(existsSync(join(resDir, 'drawable', 'ic_launcher_background.xml')));

  for (const [density, size] of [
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ] as const) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const file = join(resDir, `mipmap-${density}`, name);
      assert.ok(existsSync(file), `${file} is missing`);
      // PNG header carries the dimensions: width at bytes 16-19.
      const header = readFileSync(file).subarray(16, 24);
      assert.equal(header.readUInt32BE(0), size, `${file} is not ${size}px wide`);
      assert.equal(header.readUInt32BE(4), size, `${file} is not ${size}px tall`);
    }
  }
});

test('the foreground stays inside the adaptive-icon safe zone', () => {
  const resDir = join(root, 'android', 'app', 'src', 'main', 'res');
  const foreground = readFileSync(join(resDir, 'drawable', 'ic_launcher_foreground.xml'), 'utf8');

  // The hexagon ring is the outermost path; every point of it has to sit within
  // 33dp of centre, or a round launcher mask shaves an edge off.
  const ring = foreground.match(/android:pathData="(M[\d.,\s]+Z)"/)?.[1] ?? '';
  assert.ok(ring.length > 0, 'the ring path is missing');

  const points = [...ring.matchAll(/(\d+\.\d+),(\d+\.\d+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
  assert.ok(points.length >= 5, 'the ring should be a hexagon');
  for (const [x, y] of points) {
    const distance = Math.hypot(x! - 54, y! - 54);
    assert.ok(distance <= 33, `ring point at ${x},${y} is ${distance.toFixed(1)}dp from centre`);
  }
});

test('the seal in the page and the seal in brand/logo.svg are the same shape', () => {
  const logo = readFileSync(join(root, 'brand', 'logo.svg'), 'utf8');
  const component = readFileSync(join(root, 'src', 'web', 'components', 'Logo.tsx'), 'utf8');

  const shapes = (source: string): string[] =>
    [...source.matchAll(/\bd="(M[^"]+)"/g)].map((match) => match[1]!.replace(/\s+/g, ' ').trim());

  const inFile = shapes(logo);
  assert.ok(inFile.length >= 3, 'brand/logo.svg should carry the ring, the shaft and the head');
  for (const shape of inFile) {
    assert.ok(component.includes(shape), `Logo.tsx does not draw ${shape}`);
  }
  assert.match(component, /currentColor/, 'the page mark should take its colour from CSS');
});

test('the launch theme exists and matches the badge', () => {
  const resDir = join(root, 'android', 'app', 'src', 'main', 'res');
  const styles = readFileSync(join(resDir, 'values', 'styles.xml'), 'utf8');
  const colours = readFileSync(join(resDir, 'values', 'colors.xml'), 'utf8');
  const logo = readFileSync(join(root, 'brand', 'logo.svg'), 'utf8');

  assert.match(manifest, /android:theme="@style\/Theme\.PatchPilot"/);
  assert.match(styles, /<style name="Theme\.PatchPilot"/);
  assert.match(styles, /android:windowBackground">@color\/launch_background/);

  // One colour of record: the plate in the logo is the window background.
  assert.match(colours, /<color name="launch_background">#080b10<\/color>/);
  assert.match(logo, /#080d13/, 'brand/logo.svg should carry the same dark plate');
});

test('the folder grant is the one way in, and it needs no storage permission', () => {
  const shell = nativeShell;
  const scanner = readFileSync(join(javaDir, 'MorpheScanner.java'), 'utf8');
  const activity = readFileSync(join(javaDir, 'MainActivity.java'), 'utf8');

  // The picker itself.
  assert.match(shell, /Intent\.ACTION_OPEN_DOCUMENT_TREE/);
  assert.match(shell, /FLAG_GRANT_PERSISTABLE_URI_PERMISSION/);
  assert.match(shell, /takePersistableUriPermission/);
  assert.match(activity, /NativeShell\.REQUEST_FOLDER/);
  assert.match(activity, /onFolderPicked\(resultCode, data\)/);

  // Reading the granted tree uses DocumentsContract, not a file path.
  assert.match(scanner, /getPersistedUriPermissions\(\)/);
  assert.match(scanner, /buildChildDocumentsUriUsingTree/);
  assert.match(scanner, /openInputStream/);

  // And it is not a back door to the whole filesystem: all-files access is
  // deliberately not requested.
  assert.doesNotMatch(manifest, /MANAGE_EXTERNAL_STORAGE/);
  assert.doesNotMatch(manifest, /READ_MEDIA_/);
});

test('a store link, a share and a shortcut all land in the shell', () => {
  // The manifest has to accept the four ways in that LaunchTarget can parse.
  const viewFilters = matches(manifest, /android:(?:scheme|host)="([^"]+)"/g);
  for (const entry of ['market', 'play.google.com', 'patchpilot']) {
    assert.ok(viewFilters.includes(entry), `nothing in the manifest accepts ${entry}`);
  }
  assert.match(manifest, /android:mimeType="text\/plain"/, 'sharing a link to PatchPilot should work');
  assert.match(manifest, /android\.app\.shortcuts/, 'the shortcuts resource is not declared');

  // Shortcuts: declared labels and icons must exist, and they must come back here.
  const shortcutsFile = join(root, 'android', 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
  assert.ok(existsSync(shortcutsFile), 'shortcuts.xml is missing');
  const shortcuts = readFileSync(shortcutsFile, 'utf8');
  const defined = new Set(matches(strings, /<string name="([^"]+)"/g));
  const drawables = join(root, 'android', 'app', 'src', 'main', 'res', 'drawable');
  const ids = matches(shortcuts, /android:shortcutId="([^"]+)"/g);
  assert.ok(ids.length >= 3, 'expected a shortcut per tab that is worth opening directly');
  for (const name of matches(shortcuts, /@string\/([A-Za-z0-9_]+)/g)) {
    assert.ok(defined.has(name), `shortcuts.xml references @string/${name}, which is not defined`);
  }
  for (const name of matches(shortcuts, /@drawable\/([A-Za-z0-9_]+)/g)) {
    assert.ok(existsSync(join(drawables, `${name}.xml`)), `shortcut icon ${name} is missing`);
  }
  for (const target of matches(shortcuts, /android:targetPackage="([^"]+)"/g)) {
    assert.equal(target, 'app.patchpilot', 'a shortcut points at another app');
  }
  for (const data of matches(shortcuts, /android:data="([^"]+)"/g)) {
    assert.match(data, /^patchpilot:\/\/[a-z]+$/, `${data} is not a link the app can parse`);
  }
});

test('the page asks for a launch target the same way the shell clears it', () => {
  assert.match(nativeShell, /case "app\.launchTarget"/, 'the shell must answer app.launchTarget');
  assert.match(nativeShell, /launchTarget = null/, 'the target is read once, not on every reload');
  assert.match(nativeTs, /bridge\.call\('app\.launchTarget'/, 'the page must ask for the target');
  assert.match(nativeShell, /case "ui\.notify"/, 'the shell must be able to post a notification');
  assert.match(nativeTs, /bridge\.call\('ui\.notify'/, 'the page must be able to ask for one');
  assert.match(nativeShell, /POST_NOTIFICATIONS/, 'Android 13 needs the notification permission');
});
