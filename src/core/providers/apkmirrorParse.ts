import type { ApkFileType } from '../../shared/types.ts';
import { extractForms, extractLinks, type HtmlForm, type Link, pageMentionsVersion } from './scrape.ts';

/**
 * Pure helpers for reading APKMirror pages.
 *
 * APKMirror has no API and its markup changes every so often, so the strategy is
 * to pull every link and form out of a page once, then decide what it is from the
 * URL shape and the text around it. Keeping that reasoning in pure functions means
 * it can be tested against saved pages without touching the network.
 *
 * The page shapes these understand:
 *
 *   search    /?post_type=app_release&searchtype=apk&s=<query>
 *   release   /apk/<developer>/<app>/<app>-<version>-release/
 *   variant   /apk/<developer>/<app>/<app>-<version>-release/<app>-<version>-android-apk-download/
 *   download  ...-android-apk-download/download/?key=<token>
 *   post      /wp-content/themes/APKMirror/download.php  (form target, answers 302)
 */

export const SITE = 'https://www.apkmirror.com';

export function searchUrl(query: string, site: string = SITE): string {
  return `${site.replace(/\/+$/, '')}/?post_type=app_release&searchtype=apk&s=${encodeURIComponent(query)}`;
}

/** Version strings as APKMirror writes them into slugs: 21.43.523 → 21-43-523. */
export function versionSlugs(version: string): string[] {
  const cleaned = version.trim().replace(/^v/i, '');
  const dashed = cleaned.replace(/[^0-9a-z]+/gi, '-').replace(/^-|-$/g, '');
  const squashed = cleaned.replace(/[^0-9a-z]+/gi, '');
  return [...new Set([dashed.toLowerCase(), squashed.toLowerCase()])].filter((slug) => slug.length > 0);
}

function pathOf(link: Link): string {
  try {
    return decodeURIComponent(new URL(link.url).pathname);
  } catch {
    return '';
  }
}

/** Release pages for the version we want, newest-looking first. */
export function pickReleaseLinks(html: string, baseUrl: string, versionName: string | null): Link[] {
  const releases = extractLinks(html, baseUrl).filter((link) => /-release\/?$/.test(new URL(link.url).pathname));
  if (!versionName) return releases;

  const slugs = versionSlugs(versionName);
  const matching = releases.filter((link) => {
    const haystack = `${pathOf(link).toLowerCase()} ${link.text.toLowerCase()}`;
    return slugs.some((slug) => haystack.includes(slug)) || pageMentionsVersion(haystack, versionName);
  });
  return matching.length ? matching : [];
}

/** App pages, for the case where the search lands on the app rather than a release. */
export function pickAppLinks(html: string, baseUrl: string, packageName: string): Link[] {
  const seen = new Set<string>();
  return extractLinks(html, baseUrl)
    .filter((link) => /^\/apk\/[^/]+\/[^/]+\/?$/.test(pathOf(link)))
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return link.text.length > 0 || pathOf(link).length > 0 || packageName.length > 0;
    });
}

/**
 * Variant pages on a release page: one per architecture/DPI/format combination.
 * APKMirror suffixes these `-android-apk-download` for single APKs and
 * `-bundle-download` / `-apkm-download` style paths for split formats, so both
 * families are accepted and scored later.
 */
export function pickVariantLinks(html: string, baseUrl: string): Link[] {
  const seen = new Set<string>();
  return extractLinks(html, baseUrl)
    .filter((link) => /-(?:android-apk|apk|bundle|apkm|apks|xapk)-download\/?$/.test(new URL(link.url).pathname))
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
}

/** "Download" buttons on a variant page that carry a one-time key. */
export function pickKeyedDownloadLinks(html: string, baseUrl: string): Link[] {
  return extractLinks(html, baseUrl).filter((link) => {
    const url = link.url.toLowerCase();
    return url.includes('/download/') && url.includes('key=') && !url.includes('download.php');
  });
}

/**
 * The form APKMirror posts to fetch the file. Its action is `download.php`; other
 * forms on the page (search, newsletter) are ignored.
 */
export function pickDownloadForm(html: string, baseUrl: string): HtmlForm | null {
  const forms = extractForms(html, baseUrl);
  const download = forms.find((form) => /download\.php/i.test(form.action));
  if (download && download.fields.length) return download;
  const posting = forms.find((form) => form.method === 'post' && form.fields.length > 0);
  return posting ?? null;
}

/** Ranks variants: right format first, then the architecture the user prefers. */
export function scoreVariant(
  link: Link,
  fileType: ApkFileType | null,
  preferAbi: string | null,
): number {
  const haystack = `${link.url} ${link.text}`.toLowerCase();
  const wantsBundle =
    fileType === 'APKM' ||
    fileType === 'APKS' ||
    fileType === 'APKS_REQUIRED' ||
    fileType === 'XAPK' ||
    fileType === 'XAPK_REQUIRED';

  let score = 0;
  if (wantsBundle) {
    if (/bundle/.test(haystack)) score += 8;
    if (/apkm|apks|xapk/.test(haystack)) score += 4;
    if (/nodpi/.test(haystack)) score -= 2;
  } else {
    if (/nodpi/.test(haystack)) score += 5;
    if (/universal/.test(haystack)) score += 4;
    if (/bundle/.test(haystack)) score -= 5;
  }
  if (preferAbi) {
    const abi = preferAbi.toLowerCase().replace(/_/g, '-');
    if (haystack.includes(abi)) score += 3;
  }
  // "arm64-v8a + armeabi-v7a" style rows are the common single-APK answer.
  if (/arm64-v8a/.test(haystack)) score += 1;
  return score;
}

/** True when a response is Cloudflare's interstitial rather than the page asked for. */
export function looksBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /cf-challenge|Just a moment\.\.\.|Attention Required|Enable JavaScript and cookies/i.test(html);
}
