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

```
Morphe patches ──► required package + version + signing certificate
                              │
              PatchPilot asks each source for exactly that build
                              │
     download ──► read the manifest ──► check the cert ──► library
```

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Requires Node 20.19+ (developed on Node 22). No database, no accounts, no external services of its own.

```bash
npm run dev      # server + Vite in one process (single port)
npm start        # build the web UI, then serve it
npm test         # parsers, mirrors, catalog, verification, job flow, releases, UI render
npm run check:java     # parse the Android sources without a Gradle build
npm run changelog      # regenerate CHANGELOG.md from the commit log
npm run version:next   # what the next release would be called, from the commit log
npm run cli -- list
```

## What it actually does

1. **Reads patch bundles.** Every Morphe patch repository publishes `patches-list.json`, which names each patch's
   packages, supported versions, per-ABI version codes, required file type (`APK_REQUIRED`, `APKS_REQUIRED`, …) and the
   signing certificates of the stock app. PatchPilot loads three popular bundles out of the box, accepts any GitHub
   repository that follows the layout, and can read a `.mpp` you drop in.
2. **Ranks the versions.** Per app it shows every supported version, marks the experimental ones, and recommends the
   newest *stable* target (a target counts as experimental when no stable patch covers it). Version comparison is
   numeric-segment aware, so `21.10` sorts above `21.9` — plain string sorting gets that wrong.
3. **Asks the sources.** Sources run in priority order: APKPure, APKMirror, F-Droid, GitHub releases and Morphe's own
   download helper. Each reports what it found — or exactly why it found nothing — into a live job log.
4. **Verifies before saving.** The download is opened, its binary `AndroidManifest.xml` decoded, its APK Signing Block
   (v2/v3) parsed, and the result compared with the bundle. Wrong package, wrong version, wrong file type or a foreign
   signing certificate means the file is deleted, not filed.
5. **Files it in the library.** Verified APKs land in `data/library` under a predictable name, ready for Morphe
   Manager's *Select an APK* picker, and can be downloaded to your device from the browser.

## Verification is the point

Most "APK downloader" tools hand you whatever the mirror served. PatchPilot checks five things, and the checks are the
reason it exists:

| Check | How | Fails the file |
| --- | --- | --- |
| Readable archive | Zip central directory walk (zip64 aware), entry extraction | yes |
| Package name | Binary `AndroidManifest.xml` (AXML) decoded from the string pool + resource map | yes |
| Version | `versionName` from the manifest, plus `versionCode` against the bundle's per-ABI codes | yes |
| Signing certificate | APK Signing Block v2/v3 → X.509 chain → SHA-256, compared with the bundle's `signatures` | yes |
| File type | `APK_REQUIRED` versus a split bundle (`.apkm`/`.xapk`/`.apks`), which is read from its `base.apk` | yes |

The signing-certificate check is what separates "the app" from "a repack someone uploaded": PatchPilot computes the
SHA-256 of the certificate inside the APK's v2/v3 signing block and compares it with the fingerprint listed in the patch
bundle. v1-only APKs cannot be checked that way, and are reported as a warning rather than silently accepted.

All of it is implemented in this repository with no dependencies beyond Node's standard library:

```
src/server/apk/zip.ts        random-access zip reader (central directory, zip64, inflate)
src/server/apk/axml.ts       binary AndroidManifest parser (string pool, resource map, typed attributes)
src/server/apk/signblock.ts  APK Signing Block v2/v3 → certificate digests
src/server/apk/verify.ts     container detection, split bundle handling, the five checks
src/server/apk/fixture.ts    builds genuine fixture APKs (manifest + v2 signature) for tests
```

## The mark

A hexagon seal with a compass needle pointing at the upper right — the bundle is the package, the needle is PatchPilot
picking the one build your patches accept. Sources live in [`brand/`](brand/README.md); the same paths drive the web
header, the favicon and the Android launcher icon (adaptive, with the Android 13 themed-icon silhouette).

## Only what your Morphe has

PatchPilot offers patches, and therefore apps, **only from the bundles your Morphe has loaded**. Nothing ships switched
on: a bundle that is not in your Morphe would suggest apps your patches cannot touch, so the catalog starts empty and
fills from what you tell it.

- **Reading Morphe Manager** *(Android)*: every launch, PatchPilot asks Android what it can see of Morphe — its install,
  a `.mpp` or `patches-list.json` it left in a shared folder, and on a rooted device its own preferences file, which
  names the repositories it has. Anything found is loaded before you tap anything.
- **Bundles tab → Import from Morphe**: paste the sources from Morphe's patch-source screen, one per line
  (`owner/repo` or a full GitHub URL). Known bundles are switched on, new ones are fetched, and anything it cannot use
  (`https://…/patches.mpp`, a bare file name) is reported rather than half-imported.
- **Bundles tab → Load a .mpp file**: a bundle Morphe reads from a local file — the same file, the same patch list.
- **The toggles** are the manual version of the same statement: "this bundle is loaded in my Morphe".

The Catalog API reports the arithmetic (`morphe: { loaded, available }`) so the UI can tell "nothing loaded yet" apart
from "nothing matches".

**What "reading Morphe" can and cannot do.** Android does not let one app read another's private files, and Morphe keeps
its source list there. So the read is best-effort by design: the install is always detected, shared-folder bundles are
picked up whenever the OS allows it, and a rooted device gets the preferences file outright. When the answer is "nothing
readable", the app says that in the Bundles tab and the Doctor — it never falls back to guessing which bundles you use.

## Doctor

The **Doctor** tab runs every check that explains a failure which is nobody's fault: each enabled source is contacted
once (distinguishing "down" from "refusing automated requests"), the bundles are checked for age and emptiness, the
library for size and unchecked files, and — on the phone — storage, install permission and notifications. Every problem
comes with a hint, and the same checks run on the server and on the device.

## Sources

| Source | Kind | Notes |
| --- | --- | --- |
| **APKPure** | file | Primary source. Reads the version list first (no HTML scraping), then requests the exact `versionCode` from `d.apkpure.com`; falls back to scraping the versions page. |
| **APKMirror** | file (scraped) | Primary source. Walks search → release → variant → `download.php` form with a cookie jar, matching the version slug rather than page text. Cloudflare is detected and reported, not silently swallowed. |
| **F-Droid** | file | Official API, exact builds by version code. Only covers apps published on F-Droid. |
| **GitHub releases** | file | Uses `config/github-apps.json` to map packages to repositories. Add your own entries. |
| **Morphe helper** | page | `api.morphe.software` — the lookup Morphe Manager itself performs. Returns a mirror page; PatchPilot crawls it for a direct file first. |
| **Offline fixture** | file | Off by default. Generates a stand-in APK with the requested package/version for demos and tests. Never a real app. |

APKPure and APKMirror come first because they are the only sources that keep every historical release of a Play
Store app; a patch that targets YouTube 21.43.523 needs that exact build, and F-Droid will never have it. Both
mirrors match on **version code** as well as version name, so an app that shipped several builds under one name still
resolves to the right one, and both distinguish a Cloudflare challenge from a real "not found" so the job log tells
you which happened.

Sources can be reordered, disabled, and probed for reachability in the **Sources** tab. Nothing is hard-wired: if a
mirror changes its HTML, the failure is visible in the job log instead of a silent wrong download.

## Bundles

Built in: [Morphe Patches](https://github.com/MorpheApp/morphe-patches),
[hxreborn/morphe-patches](https://github.com/hxreborn/morphe-patches),
[Piko](https://github.com/crimera/piko).

- **Add by repository** — any repo with `patches-list.json` at its root.
- **Upload a `.mpp`** — PatchPilot opens the archive and reads the embedded patch list, so you can inspect a bundle
  before installing it into Morphe.
- **Disable / refresh / remove** — bundled sources can be disabled but not removed.

Both `patches-list.json` shapes are supported: the current `compatiblePackages` array and the legacy
`{"package": ["version", …]}` map still used by some forks.

Patch data is cached in `data/cache/bundles`. If the network is unavailable, PatchPilot falls back to the cache and then
to a snapshot of three bundles shipped in `fixtures/bundles` — so a fresh clone is never an empty screen.

## Command line

```bash
npx tsx src/server/cli.ts --version
npx tsx src/server/cli.ts list --stable
npx tsx src/server/cli.ts versions com.google.android.youtube
npx tsx src/server/cli.ts get com.google.android.youtube                 # recommended version
npx tsx src/server/cli.ts get com.google.android.youtube --version 21.30.216 --out ~/Downloads
npx tsx src/server/cli.ts verify ~/Downloads/youtube.apk --package com.google.android.youtube
npx tsx src/server/cli.ts bundles
```

`get` streams the same provider log the UI shows and exits non-zero when nothing verifies. Handy for scripting a patch
pipeline around Morphe.

## Releases

Merging into `main` is the release. The version is not typed anywhere by hand:

1. The **Release** workflow reads the commits since the last `v*` tag and picks the bump from the commit messages —
   `feat:` is a minor release, `fix:`/`perf:`/an unconventional message is a patch, `feat!:` or a
   `BREAKING CHANGE:` trailer is a major one. Chores, docs, tests and CI changes produce no release at all, so the
   workflow simply exits.
2. It stamps that version into `package.json`, runs the typecheck and the test suite, builds the web bundle and the
   Android APK, and only then tags the merge commit.
3. It publishes a GitHub release with:

   | Asset | What it is |
   | --- | --- |
   | `patchpilot-<version>.tar.gz` | The whole server: `dist/`, `src/`, `config/`, `fixtures/`, `package*.json` |
   | `patchpilot-android-<version>.apk` | The Android client, `versionName`/`versionCode` taken from the tag |
   | `SHA256SUMS` | Checksums for both |

`CHANGELOG.md` is generated from the same commits (`npm run changelog`) and committed by the same workflow step that
keeps `package.json` in step, so the file and the GitHub releases never disagree.

No release commit is needed: the tag is the source of truth and `PATCHPILOT_VERSION` carries it into the build. The
workflow does push a `chore(release): vX.Y.Z [skip ci]` commit afterwards so `package.json` stays in step, but the
release stands even if branch protection rejects that push.

Want a specific bump? Run the workflow by hand with `bump: minor`. Want to know what a merge would produce? Ask locally:

```bash
npm run version:next -- --bump auto            # JSON: version, tag, bump, release
npm run version:next -- --notes-out notes.md   # and write the release notes
```

PatchPilot reports its own version at `/api/health`, in the UI footer, and via `cli --version`.

## Android app

`android/` contains PatchPilot for Android — a **standalone** app. It reads the patch bundles, finds the exact build on
APKPure or APKMirror, downloads it, verifies it on the device and puts it in `Downloads/PatchPilot/`, right where
Morphe Manager's *Select an APK* picker expects it — and offers the installer, so the APK never has to leave the phone.
No computer, no server, no network setup. Every release attaches an installable APK.

Nothing was reimplemented for the phone. The React UI is the same build, and the catalog, the mirror scrapers, the job
runner and the verification rules are the same TypeScript, running inside the Android WebView:

```
React UI (src/web)                 unchanged — still calls /api/...
      ▼
in-page backend (src/app)          answers /api/... on the device
      ▼
NativeShell.java                   sockets · files · PackageManager · MediaStore
      ▼
APKPure / APKMirror            Downloads/PatchPilot
```

Only what Android alone can do lives in Java: HTTP with a cookie jar and real redirect control, the filesystem, the
public Downloads folder, and asking `PackageManager` what an APK actually is (package, version, signing certificate
digests). The comparison against the bundle is shared with the server, so a file is accepted or rejected for the same
reasons on both platforms. `test/standalone.test.ts` drives the whole standalone stack against a fake shell.

See [android/README.md](android/README.md) for the layout, the build, the four signing secrets, and why it has no Gradle
wrapper.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the web UI and API |
| `PATCHPILOT_DATA_DIR` | `./data` | Library, caches, job data |
| `PATCHPILOT_OFFLINE` | unset | `1` = never touch the network (cache/snapshot only) |
| `PATCHPILOT_DEMO` | unset | `1` = enable the offline fixture source |
| `PATCHPILOT_VERSION` | `package.json` | Version reported by the server; set by the release workflow |
| `PATCHPILOT_COMMIT` | unset | Short SHA reported by `/api/health` |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | Optional; raises GitHub API rate limits when `raw.githubusercontent.com` is blocked |

If your network uses a private CA (corporate proxy, hosted sandbox), Node's fetch may reject GitHub with
`TLS verification failed`; run with `NODE_OPTIONS=--use-system-ca` or set `NODE_EXTRA_CA_CERTS`.

Files:

```
config/github-apps.json   package → GitHub repository mapping for the GitHub source
data/library/             verified APKs
data/library.json         library index
data/cache/bundles/       cached patches-list.json per bundle
data/settings.json        source order/state, preferences
```

## API

The UI is a thin client over a small JSON API — everything is scriptable:

```
GET    /api/health
GET    /api/catalog[?refresh=1]
GET    /api/apps/:packageName
POST   /api/resolve                        { packageName, version }
GET    /api/bundles                        POST /api/bundles { repo }
POST   /api/bundles/upload?name=x.mpp      POST /api/bundles/:id/refresh
POST   /api/downloads                      { packageName, version?, providers? }
GET    /api/downloads/:id                  GET /api/downloads/:id/events  (SSE)
POST   /api/downloads/:id/cancel
GET    /api/library                        GET /api/library/:id/file
POST   /api/verify?name=app.apk[&packageName=…&version=…&keep=1]   (raw body)
```

## Troubleshooting

**"Cloudflare or a region block"** — APKMirror and sometimes APKPure refuse datacenter IPs. Use the *open in browser*
links in the job log, download by hand, and use **Verify a file** in the Library tab.

**"Every source was rejected"** — that is the verification doing its job. The log names the failing check; the usual
causes are a mirror serving the newest build instead of the requested one, or a bundle that pins per-ABI version codes
your download does not match.

**Nothing loads / catalog is tiny** — check the Bundles tab: a bundle showing *bundled snapshot* means the live fetch
failed. Rates on the GitHub API are 60 requests/hour unauthenticated; set `GITHUB_TOKEN` to raise that.

**Hosted preview** — mirrors are usually unreachable from a hosted sandbox (only GitHub is allowlisted). Turn on the
offline fixture source to walk the whole flow; run PatchPilot on your own machine for real downloads.

## Legal

PatchPilot hosts nothing. It reads public patch metadata, asks public sources for files, and verifies what comes back.
Only download and patch apps you are licensed to use, and respect the terms of the mirrors you query. Morphe itself is
a separate project — this tool only prepares its input.

## Development

```
src/server/          express API, bundle registry, catalog, providers, jobs, library, CLI
src/web/             React UI (Vite), hand-written CSS
src/shared/          types and labels shared by both
scripts/             conventional-commit → version/notes logic used by the release workflow
android/             the Android client (Java, framework only, no AndroidX)
test/                node:test suites
fixtures/bundles/    snapshot of three patch bundles (patch metadata only)
fixtures/apk/        a real 5 KB sample APK (Android API demos) used by the parser tests
fixtures/testkey/    throwaway key/cert that signs generated fixtures
```

Tests cover version ordering, both bundle formats, catalog merging and recommendation, the zip/AXML/signing-block
readers (against a real APK and generated ones), every verification check, offline registry loading, and a complete
download → verify → library job — including the case where a source hands back the wrong version.

The two mirrors get their own suite: their page and JSON parsers are tested against saved copies of real
APKMirror/APKPure responses in `fixtures/pages`, and both providers are driven end-to-end against a local HTTP server
that replays those pages — search, release, variant, `download.php` POST, `d.apkpure.com` redirect, a Cloudflare
interstitial, and a scrape-only fallback for APKPure. That keeps the archive-walking logic honest without touching the
live sites.

`fixtures/README.md` explains where the sample APK, bundle snapshots and test key come from.

MIT licensed.
