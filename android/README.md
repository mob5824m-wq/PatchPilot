# PatchPilot for Android

A **standalone** app. No server, no computer, no network sharing: it reads the patch bundles, finds the exact APK a
patch needs on APKPure or APKMirror, downloads it, verifies it on the device, and puts it in
`Downloads/PatchPilot/` — where Morphe Manager's *Select an APK* picker can see it.

Every release attaches an installable APK (`patchpilot-android-<version>.apk`).

## How a standalone app reuses a server codebase

The UI was written as a React client of PatchPilot's JSON API. Rather than rewrite it in Android views, the app keeps
the UI **and the backend logic**, and replaces only the layer underneath:

```
React UI (src/web)                     unchanged, still calls /api/...
        │  fetch('/api/catalog'), EventSource('/api/downloads/:id/events')
        ▼
in-page backend (src/app)              answers those calls inside the WebView
        │  catalog · providers · jobs · library · bundle registry
        ▼
NativeShell.java                       the only platform-specific code
        │  sockets · files · PackageManager · MediaStore
        ▼
APKPure / APKMirror                 Downloads/PatchPilot
```

That means the mirror scrapers, the bundle parsers and the verification rules are *the same code* the desktop build
runs — and the same tests cover them (`test/providers.test.ts`, `test/standalone.test.ts`). Nothing is reimplemented in
Java except what only Android can do.

Key pieces:

| Path | Role |
| --- | --- |
| `src/app/install.ts` | Detects the shell at startup, installs the `/api` fetch shim, the `EventSource` shim and the mirror transport |
| `src/app/router.ts` | The JSON API, implemented in the page |
| `src/app/jobs.ts` | Job runner: ask each source, download, verify, file it |
| `src/app/bundles.ts` | Bundle registry; seeds from `fixtures/bundles`, refreshes from GitHub |
| `src/app/mpp.ts` | Reads `.mpp` archives with `DecompressionStream` (no zip dependency) |
| `src/web/*` | Shared UI, untouched |
| `android/app/src/main/java/app/patchpilot/` | `MainActivity` (WebView + assets), `NativeShell` (JS bridge), `HttpBridge`, `ApkInspector`, `LibraryStore` |

## Verification, on the phone

The desktop build decodes the binary manifest and the APK Signing Block itself. Android already does both properly, so
`ApkInspector` asks `PackageManager` for the package name, version name, version code and the SHA-256 of every signing
certificate — the exact digests the patch bundles pin. Split bundles (`.apkm`, `.xapk`, `.apks`) are opened as zips and
their base APK is inspected the same way.

The comparison against the bundle (`src/shared/verifyMeta.ts`) is shared with the server, so the same file is accepted
or rejected for the same reasons on both platforms. A rejected download is deleted, never published.

## Build

The release workflow builds this on every merge to `main`, so nobody needs an Android SDK to get a working build:

```bash
npm ci && npm run build          # the UI must exist before Gradle runs: the APK carries dist/web
cd android
gradle assembleRelease           # app/build/outputs/apk/release/app-release.apk
gradle assembleRelease -PpatchPilotVersion=1.2.3
```

Needs JDK 17, Gradle 8.9+ (AGP 8.7.3) and an Android SDK with `compileSdk 35`. There is no Gradle wrapper in the
repository on purpose — the wrapper jar is a binary blob and CI pins the Gradle version instead
(`gradle/actions/setup-gradle`). Run `gradle wrapper` once if you prefer one locally.

`-PpatchPilotVersion` sets both `versionName` and `versionCode` (`1.2.3` → `10203`). Without it the APK reports
`0.0.0`; the release workflow always passes the tag it is publishing, and the app shows that version in its footer.

The web bundle is copied into `app/src/main/assets/web/` by a `Sync` task at build time and is gitignored — one source
of truth for the UI.

## Signing

`app/build.gradle.kts` checks four environment variables:

| Variable | What it is |
| --- | --- |
| `PATCHPILOT_KEYSTORE` | Path to a `.jks`/`.keystore` file |
| `PATCHPILOT_KEYSTORE_PASSWORD` | Store password |
| `PATCHPILOT_KEY_ALIAS` | Key alias |
| `PATCHPILOT_KEY_PASSWORD` | Key password |

With them set the release APK is signed properly. Without them it falls back to the debug key, which **installs fine
but cannot update an installation signed with a different key** — fine for trying it out, not for distribution.

## Permissions

| Permission | Why |
| --- | --- |
| `INTERNET` | APKPure, APKMirror, GitHub, F-Droid |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=28`) | Writing into the public `Downloads` folder on Android 9 and older; Android 10+ uses MediaStore instead |

No cleartext traffic: all requests go through `HttpBridge`, and the WebView only ever loads the app's own assets from
`https://patchpilot.local/`.

## Known limits

- **Split bundles** are verified through their base APK. The bundle is saved intact, but PatchPilot cannot prove the
  config splits match — the same caveat the desktop build documents.
- **No GitHub token**: authenticated GitHub requests are a desktop feature; the app uses the anonymous rate limit.
- The app cannot be built or run in a CI container without an Android SDK; `test/standalone.test.ts` exercises the
  standalone backend against a fake shell so the logic is covered regardless.
