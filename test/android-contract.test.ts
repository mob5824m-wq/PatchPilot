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
  const implemented = new Set(matches(nativeShell, /case\s+"([^"]+)":/g));
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
