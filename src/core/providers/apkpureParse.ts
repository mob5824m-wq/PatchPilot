import type { ApkFileType } from '../../shared/types.ts';
import { extractLinks, nearbyText, type Link } from './scrape.ts';
import { collectUrls, pickNumber, pickString, walkObjects } from './scan.ts';

/**
 * Pure helpers for APKPure.
 *
 * APKPure is the friendlier of the two big mirrors: its site is server-rendered,
 * and the download host accepts a package name plus a version code, which is
 * exactly the pair a patch bundle hands us. Three routes are understood here:
 *
 *   1. `api.pureapk.com/m/v3/cms/app_version?package_name=…` — version list JSON
 *   2. `https://d.apkpure.com/b/APK/<pkg>?versionCode=<code>` — direct file
 *   3. `apkpure.com/<slug>/<pkg>/versions` — HTML list of per-version links
 */

export const SITE = 'https://apkpure.com';
export const DOWNLOAD_HOST = 'https://d.apkpure.com';

export interface PureVersion {
  versionName: string | null;
  versionCode: number | null;
  /** Any download URLs the payload carried itself. */
  urls: string[];
}

/**
 * Pulls version records out of the version-list payload. The response has been
 * seen in three shapes (an object with `data.versionList`, a bare array, and a
 * `versions` list), and field names differ between the app and the CDN, so the
 * walk is deliberately shape-agnostic.
 */
export function parseVersionList(json: unknown): PureVersion[] {
  const versions: PureVersion[] = [];
  const seen = new Set<string>();

  walkObjects(json, (record) => {
    const versionName = pickString(record, ['versionName', 'version_name', 'version']);
    const versionCode = pickNumber(record, ['versionCode', 'version_code', 'vc']);
    if (!versionName && versionCode == null) return;

    const key = `${versionName ?? ''}|${versionCode ?? ''}`;
    // The walk visits nested objects; this also keeps parents from shadowing children.
    if (seen.has(key)) return;
    seen.add(key);

    versions.push({ versionName, versionCode, urls: collectUrls(record) });
  });

  return versions;
}

export function apiHeaders(abi: string | null): Record<string, string> {
  return {
    'x-cv': '3172501',
    'x-sv': '29',
    'x-abis': abi ?? 'arm64-v8a,armeabi-v7a,armeabi',
    'x-gp': '1',
    'user-agent': 'APKPure/3.20.11 (Aegon)',
    accept: 'application/json',
  };
}

export function versionListUrl(packageName: string, apiHost = 'https://api.pureapk.com'): string {
  return `${apiHost.replace(/\/+$/, '')}/m/v3/cms/app_version?hl=en-US&package_name=${encodeURIComponent(packageName)}`;
}

/** Which APKPure "file type" word to use for a bundle requirement. */
export function downloadKeyword(fileType: ApkFileType | null): 'APK' | 'XAPK' {
  return fileType === 'APKS' ||
    fileType === 'APKS_REQUIRED' ||
    fileType === 'XAPK' ||
    fileType === 'XAPK_REQUIRED' ||
    fileType === 'APKM'
    ? 'XAPK'
    : 'APK';
}

export function directDownloadUrls(
  packageName: string,
  keyword: 'APK' | 'XAPK',
  options: { versionCode?: number | null; versionName?: string | null; downloadHost?: string },
): { url: string; label: string }[] {
  const host = (options.downloadHost ?? DOWNLOAD_HOST).replace(/\/+$/, '');
  const urls: { url: string; label: string }[] = [];
  if (options.versionCode != null) {
    urls.push({
      url: `${host}/b/${keyword}/${packageName}?versionCode=${options.versionCode}`,
      label: `APKPure ${keyword} by versionCode ${options.versionCode}`,
    });
  }
  if (options.versionName) {
    urls.push({
      url: `${host}/b/${keyword}/${packageName}?version=${encodeURIComponent(options.versionName)}`,
      label: `APKPure ${keyword} by version ${options.versionName}`,
    });
  }
  return urls;
}

function pathOf(link: Link): string {
  try {
    return decodeURIComponent(new URL(link.url).pathname);
  } catch {
    return '';
  }
}

/** App page links on a search results page. */
export function pickAppPages(html: string, baseUrl: string, packageName: string): Link[] {
  const seen = new Set<string>();
  return extractLinks(html, baseUrl)
    .filter((link) => {
      const path = pathOf(link);
      if (!path.startsWith('/')) return false;
      if (/^\/(?:search|apps|games|top|best|news|tag|category)(?:\/|$)/.test(path)) return false;
      return path.toLowerCase().includes(packageName.toLowerCase()) || path.split('/').filter(Boolean).length === 2;
    })
    .filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
}

/**
 * Matches a version as a whole token, so `21.4.3` does not match inside
 * `21.43.523` and `1.2` does not match inside `1.23`.
 */
function mentionsVersionToken(text: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(text);
}

/** Version rows on an APKPure versions page, matched to what the bundle wants. */
export function pickVersionLinks(
  html: string,
  baseUrl: string,
  wanted: { versionName: string | null; versionCodes: number[] },
): Link[] {
  const codes = new Set(wanted.versionCodes.map(String));
  const name = wanted.versionName;
  const scored: { link: Link; tier: number }[] = [];

  for (const link of extractLinks(html, baseUrl)) {
    const url = link.url.toLowerCase();
    const codeMatch = /[?&](?:versioncode|vc)=(\d+)/.exec(url);
    if (codeMatch && codes.has(codeMatch[1] ?? '')) {
      scored.push({ link, tier: 0 });
      continue;
    }
    if (!name) continue;

    // A version named in the row itself is the strongest signal. The label
    // usually sits next to the button rather than inside it, so the markup
    // immediately around the link counts too — but only at a short radius, so
    // neighbouring rows do not bleed in.
    if (mentionsVersionToken(`${decodeURIComponent(url)} ${link.text}`, name)) {
      scored.push({ link, tier: 0 });
    } else if (mentionsVersionToken(nearbyText(html, link.href, 60), name)) {
      scored.push({ link, tier: 1 });
    }
  }

  const seen = new Set<string>();
  return scored
    .sort((a, b) => a.tier - b.tier)
    .map((entry) => entry.link)
    .filter((link) => (seen.has(link.url) ? false : (seen.add(link.url), true)));
}

/** APKPure wraps its download buttons in a counter; the target is a plain link. */
export function pickDownloadLinks(html: string, baseUrl: string): Link[] {
  return extractLinks(html, baseUrl).filter((link) => {
    const url = link.url.toLowerCase();
    return (
      url.includes('/b/apk/') ||
      url.includes('/b/xapk/') ||
      url.includes('d.apkpure.com') ||
      /\.(apk|xapk|apks|apkm)(\?|$)/.test(url)
    );
  });
}

export function looksBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429) return true;
  return /cf-challenge|Just a moment\.\.\.|Access denied|captcha/i.test(html);
}
