# The PatchPilot mark

A hexagon seal with a compass needle pointing to the upper right: the bundle is the
package, the needle is PatchPilot picking the one build your patches accept. Drawn
in the app accent (`#6ee7a8`) on the app's near-black plate.

| File | What it is |
| --- | --- |
| `logo.svg` | **The canonical mark** — badge with the dark plate, 32×32 viewBox |
| `logo-mark.svg` | The same mark on transparency, for placing on other surfaces |
| `logo-512.png` / `logo-1024.png` | Raster badge for store listings, social cards, README embeds |

## Where it is used

| Surface | Asset |
| --- | --- |
| Web UI header | `src/web/components/Logo.tsx` (inline SVG, takes `currentColor` from CSS) |
| Browser tab / PWA | `src/web/public/logo.svg`, `favicon-32.png`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `manifest.webmanifest` |
| Android 8+ | `res/drawable/ic_launcher_foreground.xml` + `ic_launcher_background.xml`, wired by `res/mipmap-anydpi-v26/ic_launcher.xml` (also used as the Android 13 themed-icon silhouette) |
| Android 7.x | `res/mipmap-*/ic_launcher.png` and `ic_launcher_round.png`, 48–192 px |

## Rules

- The geometry lives in `logo.svg`. `Logo.tsx` and the Android vector mirror it, and
  `test/android-contract.test.ts` fails if the paths in one stop matching the other.
- The Android foreground is drawn on a 108dp canvas with the mark inside 66dp, so no
  launcher mask (circle, squircle, teardrop) clips an edge. A test checks the ring
  points stay within 33dp of centre.
- Colour is `#6ee7a8` on `#13212d → #080d13`. Do not recolour the seal for light
  backgrounds — use the badge, which carries its own plate.

## Regenerating the PNGs

The PNGs were rasterised from the same path coordinates as `logo.svg` (supersampled,
then Lanczos-downscaled). Any SVG renderer will do — for example:

```sh
npx @resvg/resvg-js-cli -w 1024 brand/logo.svg brand/logo-1024.png   # once, if you want a CLI
```

The Android density buckets are 48 / 72 / 96 / 144 / 192 px (`mdpi` … `xxxhdpi`).
