<p align="center">
  <img src="brand/logo.svg" alt="PatchPilot" width="96" height="96" />
</p>

# PatchPilot

[![CI](https://github.com/mob5824m-wq/PatchPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/mob5824m-wq/PatchPilot/actions/workflows/ci.yml)
[![Release](https://github.com/mob5824m-wq/PatchPilot/actions/workflows/release.yml/badge.svg)](https://github.com/mob5824m-wq/PatchPilot/releases)

**Get the exact APK a Morphe patch bundle asks for — downloaded, checked, and filed where Morphe can pick it up.**

Morphe patches only apply to specific app versions. Guessing wrong costs you a 90 MB download and a failed patch run.
PatchPilot reads the patch bundles you use, tells you which version each app's patches accept, fetches that build from
an official or third-party source, and proves it is the real thing before you touch it.

**PatchPilot is an Android app.** There is no web server and nothing to install on a computer: every release attaches a
single APK, and everything — the catalogue, the mirrors, the verification — runs on the phone.

```
Morphe patches ──► required package + version + signing certificate
                              │
              PatchPilot asks each source for exactly that build
                              │
     download ──► read the manifest ──► check the cert ──► Downloads/PatchPilot
                                                                  │
                                                     Morphe's APK picker
```

## Install

1. Download `patchpilot-android-<version>.apk` from [Releases](https://github.com/mob5824m-wq/PatchPilot/releases).
2. Install it (Android will ask you to allow installs from this browser or file manager once).
3. Open PatchPilot. It reads what it can of your Morphe, then shows the apps your bundles can patch.
4. Tap an app, tap **Download APK**, then point Morphe Manager's *Select an APK* picker at `Downloads/PatchPilot`.

Android 8.0 (API 26) or newer. No root, no storage permission, no account.

## What it actually does

1. **Reads patch bundles.** Every Morphe patch repository publishes `patches-list.json`, which names each patch's
   packages, supported versions, per-ABI version codes, required file type (`APK_REQUIRED`, `APKS_REQUIRED`, …) and the
   signing certificates of the stock app. PatchPilot loads only the bundles your Morphe has — nothing ships enabled.
2. **Ranks the versions.** Per app it shows every supported version, marks the experimental ones, and recommends the
   newest *stable* target. Version comparison is numeric-segment aware, so `21.10` sorts above `21.9` — plain string
   sorting gets that wrong.
3. **Asks the sources.** APKPure, APKMirror, F-Droid, GitHub releases and Morphe's own download helper, in priority
   order. Each reports what it found — or exactly why it found nothing — into a live job log.
4. **Verifies before saving.** The download is opened, its binary `AndroidManifest.xml` decoded, its APK Signing Block
   (v2/v3) parsed, and the result compared with the bundle. Wrong package, wrong version, wrong file type or a foreign
   signing certificate means the file is deleted, not filed.
5. **Files it where Morphe looks.** Verified APKs land in `Downloads/PatchPilot` under a predictable name, and the
   system installer can be opened straight from the library.

## What is new in this build

- **Open from a store link or a share.** Share a Play Store page to PatchPilot, or tap a `market://details?id=…` /
  `play.google.com/store/apps/details?id=…` link, and it opens on that app with the version your patches accept
  recommended. Shared text is searched for a package name, so a chat message works too.
- **Launcher shortcuts and `patchpilot://` links.** Long-press the icon for *Library*, *Bundles* or *Doctor*;
  `patchpilot://doctor?package=com.google.android.youtube` does the same from anywhere.
- **A download queue.** Tap **Add to queue** on as many apps as you like; PatchPilot downloads them one after another
  while you keep browsing, and the header shows *"Downloading YouTube · 2 of 5"*. One failure does not stop the rest.
- **"This saved APK is patchable now."** When a bundle you load supports a newer version of something already in your
  library, PatchPilot posts one notification per app and version — never the same one twice, and never for the demo
  fixtures.
- **"A newer PatchPilot is out."** The newest GitHub release is compared with the build you are running and a banner
  links to the APK. If GitHub cannot be reached the banner stays away — no version is ever guessed.

Long downloads already keep running with a progress notification that carries a cancel action, including while the app
is in the background.

## Reading your Morphe

PatchPilot offers patches, and therefore apps, **only from the bundles your Morphe has loaded**. Nothing ships switched
on: a bundle that is not in your Morphe would suggest apps your patches cannot touch, so the catalogue starts empty and
fills from what you tell it.

- **Reading Morphe Manager** — every launch PatchPilot asks Android what it can see of Morphe: its install, a `.mpp` or
  `patches-list.json` it left in a shared folder, and on a rooted device its own preferences file, which names the
  repositories it has.
- **Give it a folder** — grant Downloads (or wherever you keep bundles) once through the system picker. The grant is
  kept across restarts and scanned on every launch. No storage permission is involved.
- **Bundles → Import from Morphe** — paste the sources from Morphe's patch-source screen, one per line (`owner/repo` or
  a full GitHub URL). Anything unusable is reported rather than half-imported.
- **Bundles → Load a .mpp file** — a bundle Morphe reads from a local file, read in the app's own zip reader.

Android does not let one app read another's private files, so the routes are tried in order of reliability: a folder you
grant, then shared storage, then Morphe's private directory (root only). When all three come up empty the app says
exactly that, in the Bundles tab and in the Doctor. It never falls back to guessing.

## Verification is the point

Most "APK downloader" tools hand you whatever the mirror served. PatchPilot checks five things:

| Check | How | Fails the file |
| --- | --- | --- |
| Readable archive | Zip central directory walk (zip64 aware), entry extraction | yes |
| Package name | Binary `AndroidManifest.xml` (AXML) decoded from the string pool + resource map | yes |
| Version | `versionName` from the manifest, plus `versionCode` against the bundle's per-ABI codes | yes |
| Signing certificate | APK Signing Block v2/v3 → X.509 chain → SHA-256, compared with the bundle's `signatures` | yes |
| File type | `APK_REQUIRED` versus a split bundle (`.apkm`/`.xapk`/`.apks`), read from its `base.apk` | yes |

The signing-certificate check is what separates "the app" from "a repack someone uploaded": PatchPilot computes the
SHA-256 of the certificate inside the APK's v2/v3 signing block and compares it with the fingerprint in the patch bundle.
v1-only APKs cannot be checked that way and are reported as a warning rather than silently accepted.

Package, version and certificate come straight from Android's own `PackageManager` on the phone; the archive readers
below are used for what it will not tell you (file type, split contents, verifying a file you already have):

```
src/core/apk/zip.ts        random-access zip reader (central directory, zip64, inflate)
src/core/apk/axml.ts       binary AndroidManifest parser (string pool, resource map, typed attributes)
src/core/apk/signblock.ts  APK Signing Block v2/v3 → certificate digests
src/core/apk/verify.ts     container detection, split bundle handling, the five checks
```

## Doctor

The **Doctor** tab runs every check that explains a failure which is nobody's fault: each enabled source is contacted
once (distinguishing "down" from "refusing automated requests"), the bundles are checked for age and emptiness, the
library for size and unchecked files, and the phone for storage, install permission and notifications. Every problem
comes with a hint.

## Sources

| Source | Kind | Notes |
| --- | --- | --- |
| **APKPure** | file | Reads the version list first (no HTML scraping), then requests the exact `versionCode` from `d.apkpure.com`; falls back to scraping the versions page. |
| **APKMirror** | file (scraped) | Walks search → release → variant → `download.php` form with a cookie jar, matching the version slug rather than page text. Cloudflare is detected and reported, not silently swallowed. |
| **F-Droid** | file | Official API, exact builds by version code. Only covers apps published on F-Droid. |
| **GitHub releases** | file | Uses `config/github-apps.json` to map packages to repositories. |
| **Morphe helper** | page | `api.morphe.software` — the lookup Morphe Manager itself performs. |

APKPure and APKMirror come first because they are the only sources that keep every historical release of a Play Store
app; a patch that targets YouTube 21.43.523 needs that exact build, and F-Droid will never have it. Both match on
**version code** as well as version name, and both distinguish a Cloudflare challenge from a real "not found" so the job
log tells you which happened. Sources can be reordered, disabled and probed in the Sources tab.

## Bundles

Built in: [Morphe Patches](https://github.com/MorpheApp/morphe-patches),
[hxreborn/morphe-patches](https://github.com/crimera/piko).
[Piko](https://github.com/crimera/piko) is available but off until you say your Morphe has it.

Both `patches-list.json` shapes are supported: the current `compatiblePackages` array and the legacy
`{"package": ["version", …]}` map still used by some forks. Patch data is cached on the phone; with no network
PatchPilot falls back to the cache and then to a snapshot of three bundles shipped in `fixtures/bundles`, so a fresh
install is never an empty screen.

## The mark

A hexagon seal with a compass needle pointing at the upper right — the bundle is the package, the needle is PatchPilot
picking the one build your patches accept. Sources live in [`brand/`](brand/README.md); the same paths drive the app
header and the Android launcher icon (adaptive, with the Android 13 themed-icon silhouette).

## Releases

Merging into `main` is the release. The version is not typed anywhere by hand: the **Release** workflow reads the
commits since the last `v*` tag and picks the bump from the messages (`feat:` minor, `fix:` patch, `feat!:` or a
`BREAKING CHANGE:` trailer major; chores and docs produce no release). It stamps the version, runs the typecheck and the
tests, builds the APK, tags the commit and publishes:

| Asset | What it is |
| --- | --- |
| `patchpilot-android-<version>.apk` | The app, `versionName`/`versionCode` taken from the tag |
| `SHA256SUMS` | Its checksum |

`CHANGELOG.md` is generated from the same commits, so the file and the GitHub releases never disagree.

## Development

```bash
npm install
npm test              # node:test suites (TypeScript, runs on Node 22)
npm run check:java    # parse the Android sources without a Gradle build
npm run build         # the React UI, bundled into the APK's assets
npm run android       # build + install the app on a connected device (needs the SDK)
```

```
src/web/             React UI (Vite), hand-written CSS
src/app/             the in-page backend that answers /api/... on the device
src/core/            catalogue, providers, archive/verification readers, HTTP shim
src/shared/          types and labels shared by both
android/             the Android app (Java, framework only, no AndroidX)
test/                node:test suites
fixtures/            bundle snapshots, mirror pages, a real sample APK, a throwaway test key
```

Only what Android alone can do lives in Java: HTTP with a cookie jar and real redirect control, the filesystem, the
public Downloads folder, notifications and intents. Everything else — including the comparison that accepts or rejects a
file — is the same TypeScript that the tests drive. `test/standalone.test.ts` runs the entire stack against a fake shell
that stands in for `PackageManager`, the files and the network.

Tests cover version ordering, both bundle formats, catalogue merging and recommendation, the zip/AXML/signing-block
readers, every verification check, the mirror parsers against saved copies of real responses, the download → verify →
library flow (including a mirror serving the wrong build), the queue, the upgrade alerts, the update check, and the
launch targets. See [android/README.md](android/README.md) for the app's layout, build and signing secrets.

## Legal

PatchPilot hosts nothing. It reads public patch metadata, asks public sources for files, and verifies what comes back.
Only download and patch apps you are licensed to use, and respect the terms of the mirrors you query. Morphe itself is a
separate project — this tool only prepares its input.

MIT licensed.
