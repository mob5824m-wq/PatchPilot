# Fixtures

Everything here exists so PatchPilot's tests and offline mode have something real to work with. None of it is
distributed app code.

| Path | What it is | Why it is committed |
| --- | --- | --- |
| `apk/HelloActivity.apk` | A 5 KB sample APK from [appium/android-apidemos](https://github.com/appium/android-apidemos) (Apache-2.0), an Android API demos project. | A genuine, third-party-built APK with a *binary* `AndroidManifest.xml` and a v1 signature — the parser tests check it still decodes correctly. |
| `bundles/*.patches-list.json` | Snapshots of the `patches-list.json` published by [MorpheApp/morphe-patches](https://github.com/MorpheApp/morphe-patches), [hxreborn/morphe-patches](https://github.com/hxreborn/morphe-patches) and [crimera/piko](https://github.com/crimera/piko). | Patch *metadata only* (names, descriptions, versions, certificate fingerprints). Lets a fresh clone show a real catalog with no network, and lets tests assert against real bundle shapes. |
| `bundles/*.patches-bundle.json` | The matching bundle metadata published by those repositories. | Supplies bundle versions and `.mpp` download URLs. |
| `testkey/key.pem`, `testkey/cert.pem`, `testkey/cert.der` | A throwaway RSA key and self-signed certificate generated for this repository. | The fixture builder signs generated APKs with it so the v2 signing-block reader and the certificate check have something to find. **It is a test key: never trust, install, or reuse it.** |

Generated APKs from `src/server/apk/fixture.ts` are written to `data/demo/` at runtime and are gitignored.
