import type { ApkFileType } from '../../shared/types.ts';
import { fetchJson, HttpError, request } from '../http.ts';
import { collectUrls, pickNumber, pickString, walkObjects } from './scan.ts';
import { emptyResult, type CandidateFile, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * APKPure keeps old versions around and serves them straight from a CDN, which
 * makes it the most useful mirror for "I need exactly 21.43.523" requests.
 *
 * Two routes are tried: their internal version-list JSON (which names the exact
 * build) and their predictable `d.apkpure.com` download endpoint. Neither is a
 * documented API, so everything is verified after download and the job log says
 * exactly what was asked for.
 */

const API_HEADERS: Record<string, string> = {
  'x-cv': '3172501',
  'x-sv': '29',
  'x-abis': 'arm64-v8a,armeabi-v7a,armeabi',
  'x-gp': '1',
  'user-agent': 'APKPure/3.20.11 (Aegon)',
  accept: 'application/json',
};

interface PureVersion {
  versionName: string | null;
  versionCode: number | null;
  urls: string[];
}

function parseVersionList(json: unknown): PureVersion[] {
  const versions: PureVersion[] = [];
  walkObjects(json, (record) => {
    const versionName = pickString(record, ['versionName', 'version_name', 'version']);
    const versionCode = pickNumber(record, ['versionCode', 'version_code']);
    if (!versionName && versionCode == null) return;
    const urls = collectUrls(record);
    versions.push({ versionName, versionCode, urls });
  });
  return versions;
}

function bundleKeyword(fileType: ApkFileType | null): 'APK' | 'XAPK' {
  return fileType === 'APKS' || fileType === 'APKS_REQUIRED' || fileType === 'XAPK_REQUIRED' || fileType === 'XAPK'
    ? 'XAPK'
    : 'APK';
}

export class ApkPureProvider implements Provider {
  readonly id = 'apkpure';
  readonly label = 'APKPure';
  readonly description = 'Third-party mirror with long version archives and direct CDN links.';
  readonly homepage = 'https://apkpure.com';
  readonly kind = 'file' as const;
  readonly notes = [
    'Serves files through an undocumented endpoint: results are always verified.',
    'If the mirror only has the newest build, verification rejects it instead of saving the wrong version.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    const files: CandidateFile[] = [];
    const pages = [{ url: `https://apkpure.com/search?q=${encodeURIComponent(context.packageName)}`, label: 'Search APKPure' }];
    const details: string[] = [];

    // 1. Internal version list, which knows the exact build per version.
    try {
      const json = await fetchJson(
        `https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=${encodeURIComponent(context.packageName)}`,
        { headers: API_HEADERS, timeoutMs: 15_000 },
      );
      for (const entry of parseVersionList(json)) {
        const versionMatches = context.versionName != null && entry.versionName === context.versionName;
        const codeMatches =
          entry.versionCode != null &&
          context.versionCodes != null &&
          Object.values(context.versionCodes).includes(entry.versionCode);
        if (!versionMatches && !codeMatches) continue;
        for (const url of entry.urls) {
          files.push({
            url,
            label: `APKPure ${entry.versionName ?? ''} (versionCode ${entry.versionCode ?? '?'})`,
            expectedVersionCode: entry.versionCode,
          });
        }
      }
      if (files.length) details.push(`version list named ${files.length} download link(s)`);
      else details.push('version list has no entry for this version');
    } catch (error) {
      const message = error instanceof HttpError ? error.message : (error as Error).message;
      context.log('warn', `APKPure version list unavailable: ${message}`);
      details.push('version list unavailable');
    }

    // 2. The public, guessable download endpoint. Its links are only worth
    //    offering once the host has actually answered; otherwise the job would
    //    waste time on URLs the network cannot even reach.
    const keyword = bundleKeyword(context.fileType);
    const codes = context.versionCodes ? [...new Set(Object.values(context.versionCodes))] : [];
    const guesses: CandidateFile[] = [];
    for (const code of codes.slice(0, 2)) {
      guesses.push({
        url: `https://d.apkpure.com/b/${keyword}/${context.packageName}?versionCode=${code}`,
        label: `APKPure download by versionCode ${code}`,
        expectedVersionCode: code,
      });
    }
    if (context.versionName) {
      guesses.push({
        url: `https://d.apkpure.com/b/${keyword}/${context.packageName}?version=${encodeURIComponent(context.versionName)}`,
        label: `APKPure download by version ${context.versionName}`,
      });
    }

    if (!context.versionName && !codes.length) {
      return emptyResult('This app has no pinned version, so there is nothing exact to request from APKPure.');
    }

    const first = guesses[0];
    if (first) {
      try {
        const response = await request(first.url, {
          method: 'GET',
          redirect: 'manual',
          timeoutMs: 12_000,
          headers: API_HEADERS,
        });
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (response.status >= 400) {
          details.push(`download endpoint answered HTTP ${response.status}`);
        } else {
          // The host answered, so its links are worth handing to the downloader.
          files.push(...guesses);
          details.push(
            location
              ? `download endpoint redirects to ${new URL(location, first.url).host}`
              : 'download endpoint answered directly',
          );
        }
      } catch (error) {
        details.push(`download endpoint unreachable (${(error as Error).message})`);
      }
    }

    return {
      files,
      pages,
      detail: `APKPure: ${details.join('; ')}.`,
    };
  }
}
