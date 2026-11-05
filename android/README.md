# PatchPilot for Android

A thin client for the PatchPilot server. It is a WebView with three jobs: show the PatchPilot UI from the server on
your computer, let you switch servers, and make sure a downloaded APK lands in `Downloads/PatchPilot/` where Morphe
Manager's *Select an APK* picker can find it.

It is **not** a standalone downloader. The catalog, the mirrors, the archives and the signature checks all live in the
Node server; the phone is the screen and the destination. That is deliberate — the server does the work once, and the
APK stays small and dependency-free.

## Build

The release workflow builds this on every merge to `main` and attaches the APK to the GitHub release, so nobody needs a
local Android SDK to get a working build. To build it yourself:

```bash
# Needs JDK 17 and an Android SDK (compileSdk 35). Gradle 8.9+ required by AGP 8.7.
cd android
gradle assembleRelease         # app/build/outputs/apk/release/app-release.apk
gradle assembleRelease -PpatchPilotVersion=1.2.3
```

There is no Gradle wrapper in the repository on purpose: the wrapper jar is a binary blob, and CI pins the Gradle
version instead (`gradle/actions/setup-gradle`). Run `gradle wrapper` once if you would rather have one locally.

`-PpatchPilotVersion` sets both `versionName` and `versionCode` (`1.2.3` → `10203`). Without it the APK reports
`0.0.0`; the release workflow always passes the tag it is publishing.

## Signing

`app/build.gradle.kts` checks four environment variables:

| Variable | What it is |
| --- | --- |
| `PATCHPILOT_KEYSTORE` | Path to a `.jks`/`.keystore` file |
| `PATCHPILOT_KEYSTORE_PASSWORD` | Store password |
| `PATCHPILOT_KEY_ALIAS` | Key alias |
| `PATCHPILOT_KEY_PASSWORD` | Key password |

With them set, the release APK is signed properly. Without them it falls back to the debug key, which **installs fine
but cannot update an installation signed with a different key** — fine for trying it out, not for a real distribution.
Add the four as repository secrets (base64 the keystore and decode it in the workflow) to get stable signatures.

## What it asks for

- `INTERNET` — to reach your server; plain `http://` is allowed because home networks rarely have certificates.
- `WRITE_EXTERNAL_STORAGE` on Android 9 and older only, for the public `Downloads` folder.

The server address is the only setting. Tap the bar at the top to change it; the app remembers it, and
`192.168.1.20:3000` is accepted and normalised to `http://192.168.1.20:3000`.

## Structure

```
app/src/main/java/app/patchpilot/MainActivity.java   the whole app
app/src/main/AndroidManifest.xml                     permissions, cleartext, launcher
app/src/main/res/values/strings.xml                  UI text
```

No AndroidX, no Compose, no third-party dependencies: an `Activity`, a `WebView`, a `DownloadManager`, and the
framework file picker (`<input type="file">` in the web UI has to keep working).
