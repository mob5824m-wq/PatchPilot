# Fixtures

Everything here exists so PatchPilot's tests and offline mode have something real to work with. None of it is
distributed app code.

| Path | What it is | Why it is committed |
| --- | --- | --- |
| `apk/HelloActivity.apk` | A 5 KB sample APK from [appium/android-apidemos](https://github.com/appium/android-apidemos) (Apache-2.0), an Android API demos project. | A genuine, third-party-built APK with a *binary* `AndroidManifest.xml` and a v1 signature — the parser tests check it still decodes correctly. |
| `bundles/*.patches-list.json` | Snapshots of the `patches-list.json` published by [MorpheApp/morphe-patches](https://github.com/MorpheApp/morphe-patches), [hxreborn/morphe-patches](https://github.com/hxreborn/morphe-patches) and [crimera/piko](https://github.com/crimera/piko). | Patch *metadata only* (names, descriptions, versions, certificate fingerprints). Lets a fresh clone show a real catalog with no network, and lets tests assert against real bundle shapes. |
| `bundles/*.patches-bundle.json` | The matching bundle metadata published by those repositories. | Supplies bundle versions and `.mpp` download URLs. |
| `pages/*.html`, `pages/*.json` | Reconstructions of the pages the two mirrors serve: APKMirror search, release and variant pages plus its `download.php` form, and APKPure's version-list JSON, search page and versions page. | The mirror hosts block datacenter IPs, so the scrapers cannot be exercised against the live sites from CI. These keep the real element structure, class names, query parameters and the `download.php` POST contract, with every internal link rewritten to a relative path. `test/providers.test.ts` replays them from a local HTTP server so search → release → variant → form → file is tested for real. |
| `testkey/key.pem`, `testkey/cert.pem`, `testkey/cert.der` | A throwaway RSA key and self-signed certificate generated for this repository. | The fixture builder signs generated APKs with it so the v2 signing-block reader and the certificate check have something to find. **It is a test key: never trust, install, or reuse it.** |

Generated APKs come from `src/core/apk/fixture.ts` and are written to a temporary directory in the tests.
