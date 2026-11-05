import type { ApkFileType } from '../../shared/types.ts';
import { BROWSER_HEADERS, fetchJson, HttpError, request } from '../http.ts';
import {
  apiHeaders,
  directDownloadUrls,
  downloadKeyword,
  looksBlocked,
  parseVersionList,
  pickAppPages,
  pickDownloadLinks,
  pickVersionLinks,
  SITE,
  versionListUrl,
} from './apkpureParse.ts';
import { emptyResult, type CandidateFile, type CandidatePage, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * APKPure.
 *
 * The mirror keeps old builds around for years and its download host takes a
 * package name plus a version code — exactly the pair a patch bundle gives us —
 * so it is the most reliable way to land on *the* build Morphe needs rather than
 * "latest".
 *
 * Three routes, cheapest first:
 *   1. the version-list JSON, which names every version code APKPure holds
 *   2. `d.apkpure.com/b/APK/<pkg>?versionCode=<code>`, which serves the file
 *   3. the public versions page, scraped when the other two do not line up
 *
 * Everything is best effort and undocumented, so the job log records which route
 * produced a link, and the download is verified before it is kept.
 */

const MAX_SCRAPED_LINKS = 3;

export interface ApkPureOptions {
  /** Overridden by tests to point at a local mirror. */
  site?: string;
  downloadHost?: string;
  apiHost?: string;
}

interface ProbeOutcome {
  reachable: boolean;
  detail: string;
  fileUrl?: string;
}

export class ApkPureProvider implements Provider {
  readonly id = 'apkpure';
  readonly label = 'APKPure';
  readonly description = 'Third-party mirror with a deep version archive and direct CDN links.';
  readonly homepage = 'https://apkpure.com';
  readonly kind = 'file' as const;
  private readonly site: string;
  private readonly downloadHost: string | undefined;
  private readonly apiHost: string | undefined;

  constructor(options: ApkPureOptions = {}) {
    this.site = options.site ?? SITE;
    this.downloadHost = options.downloadHost;
    this.apiHost = options.apiHost;
  }

  readonly notes = [
    'Best odds of finding an older build the patches still accept.',
    'Uses an undocumented version endpoint; every file is verified after download.',
    'If the mirror only holds the newest build, verification rejects it instead of saving the wrong version.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    const headers = apiHeaders(context.preferAbi);
    const keyword = downloadKeyword(context.fileType);
    const searchPage = `${this.site}/search?q=${encodeURIComponent(context.packageName)}`;
    const pages: CandidatePage[] = [{ url: searchPage, label: 'Search APKPure' }];
    const files: CandidateFile[] = [];
    const notes: string[] = [];

    // 1. Version codes: the bundle's own per-ABI codes are the most authoritative.
    const bundleCode = context.versionCodes ? Object.values(context.versionCodes)[0] ?? null : null;
    let versionCode = bundleCode;
    let apiUrls: string[] = [];

    try {
      const json = await fetchJson(versionListUrl(context.packageName, this.apiHost), { headers, timeoutMs: 12_000 });
      const versions = parseVersionList(json);

      const exact = versions.find(
        (entry) =>
          (context.versionName != null && entry.versionName === context.versionName) ||
          (entry.versionCode != null && context.versionCodes != null && Object.values(context.versionCodes).includes(entry.versionCode)),
      );

      if (exact?.versionCode != null && versionCode == null) versionCode = exact.versionCode;
      if (exact) apiUrls = exact.urls;

      notes.push(
        exact
          ? `version list knows ${exact.versionName ?? 'this build'} (versionCode ${exact.versionCode ?? '?'})`
          : `version list has ${versions.length} build(s), none matching ${context.versionName ?? 'the requested build'}`,
      );
      if (exact?.versionName) {
        pages.push({
          url: `${this.site}/search?q=${encodeURIComponent(exact.versionName)}`,
          label: `APKPure search for ${exact.versionName}`,
        });
      }
    } catch (error) {
      const message = error instanceof HttpError ? error.message : (error as Error).message;
      notes.push(`version list unavailable (${message})`);
      context.log('warn', `APKPure version list: ${message}`);
    }

    // Links the version list handed over itself are used as-is.
    for (const url of apiUrls.slice(0, 2)) {
      files.push({ url, label: 'APKPure download from version list' });
    }

    // 2. The download host, asked directly. Probing first keeps the job from
    //    queueing links the network cannot even reach.
    const direct = directDownloadUrls(context.packageName, keyword, {
      versionCode,
      versionName: versionCode == null ? context.versionName : null,
      downloadHost: this.downloadHost,
    });

    if (!direct.length) {
      notes.push('no version code and no version name to request');
      return { files, pages, detail: `APKPure: ${notes.join('; ')}.` };
    }

    const probe = await this.probe(direct[0]!.url, headers);
    notes.push(probe.detail);
    context.log(probe.reachable ? 'info' : 'warn', `APKPure download host: ${probe.detail}`);

    if (probe.fileUrl) {
      files.push({
        url: probe.fileUrl,
        label: `APKPure direct download${versionCode != null ? ` (versionCode ${versionCode})` : ''}`,
      });
    }
    if (probe.reachable) {
      for (const entry of direct.slice(1)) files.push({ url: entry.url, label: entry.label });
    }

    // 3. Scrape the public site when the direct route did not produce a file.
    if (!files.length) {
      const scraped = await this.scrape(context, pages);
      files.push(...scraped.files);
      notes.push(scraped.detail);
    }

    return {
      files,
      pages,
      detail: `APKPure: ${notes.join('; ')}.`,
    };
  }

  /** Asks the download host what it would do, without downloading the body. */
  private async probe(url: string, headers: Record<string, string>): Promise<ProbeOutcome> {
    try {
      const response = await request(url, { method: 'GET', redirect: 'manual', timeoutMs: 12_000, headers });
      await response.body?.cancel().catch(() => undefined);

      if (response.status >= 400) {
        return {
          reachable: response.status < 500,
          detail: `answered HTTP ${response.status} (the build may not be in this region or may have been removed)`,
        };
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && location) {
        const target = new URL(location, url).toString();
        const fileName = new URL(target).pathname.split('/').pop() ?? '';
        if (/\.(apk|xapk|apks|apkm)$/i.test(fileName)) {
          return { reachable: true, detail: `redirects straight to ${fileName}`, fileUrl: target };
        }
        return { reachable: true, detail: `redirects to ${new URL(target).host}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (/zip|octet-stream|android/i.test(contentType)) {
        return { reachable: true, detail: 'serves the file directly', fileUrl: url };
      }
      return { reachable: true, detail: 'answered without a redirect' };
    } catch (error) {
      return { reachable: false, detail: `unreachable (${(error as Error).message})` };
    }
  }

  /** Reads the public versions page, matching the rows against the wanted build. */
  private async scrape(context: ResolveContext, pages: CandidatePage[]): Promise<{ files: CandidateFile[]; detail: string }> {
    const searchUrl = `${this.site}/search?q=${encodeURIComponent(context.packageName)}`;
    let html: string;
    try {
      const response = await request(searchUrl, {
        timeoutMs: 15_000,
        headers: { 'user-agent': BROWSER_HEADERS['user-agent']! },
      });
      if (!response.ok) return { files: [], detail: `search page answered HTTP ${response.status}` };
      html = await response.text();
      if (looksBlocked(html, response.status)) return { files: [], detail: 'search page was blocked' };
    } catch (error) {
      return { files: [], detail: `search page unreachable (${(error as Error).message})` };
    }

    const appPages = pickAppPages(html, searchUrl, context.packageName).slice(0, 3);
    if (!appPages.length) return { files: [], detail: 'no app page found in search results' };

    const codes = context.versionCodes ? Object.values(context.versionCodes) : [];
    const files: CandidateFile[] = [];
    const tried: string[] = [];

    for (const appPage of appPages) {
      const versionsUrl = `${appPage.url.replace(/\/+$/, '')}/versions`;
      pages.push({ url: versionsUrl, label: 'APKPure versions page' });
      if (tried.includes(versionsUrl)) continue;
      tried.push(versionsUrl);

      try {
        const response = await request(versionsUrl, {
          timeoutMs: 15_000,
          headers: { 'user-agent': BROWSER_HEADERS['user-agent']!, referer: searchUrl },
        });
        if (!response.ok) continue;
        const page = await response.text();

        for (const link of pickVersionLinks(page, versionsUrl, { versionName: context.versionName, versionCodes: codes }).slice(0, MAX_SCRAPED_LINKS)) {
          const codeMatch = /[?&](?:versioncode|vc)=(\d+)/i.exec(link.url);
          files.push({
            url: link.url,
            label: `APKPure versions page: ${link.text || link.url.split('/').pop()}`,
            expectedVersionCode: codeMatch ? Number(codeMatch[1]) : null,
          });
        }

        if (!files.length) {
          // The download page occasionally holds the only direct link.
          for (const link of pickDownloadLinks(page, versionsUrl).slice(0, MAX_SCRAPED_LINKS)) {
            files.push({ url: link.url, label: `APKPure link: ${link.text || 'download'}` });
          }
        }

        if (files.length) return { files, detail: `versions page supplied ${files.length} link(s)` };
      } catch {
        // Try the next candidate app page.
      }
    }

    return { files, detail: 'no matching row on the versions page' };
  }
}
