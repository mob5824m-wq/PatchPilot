import { BROWSER_HEADERS, CookieJar, HttpError, request } from '../http.ts';
import {
  looksBlocked,
  pickDownloadForm,
  pickKeyedDownloadLinks,
  pickReleaseLinks,
  pickVariantLinks,
  scoreVariant,
  searchUrl,
  SITE,
} from './apkmirrorParse.ts';
import { emptyResult, type CandidateFile, type CandidatePage, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * APKMirror.
 *
 * For the apps Morphe patches (YouTube, YouTube Music, Reddit, and most of what
 * community bundles cover) APKMirror is the only public archive that reliably
 * keeps every historical build, which makes it the single most useful source
 * here.
 *
 * There is no API, so this walks the site the way a browser does, keeping the
 * session cookie between steps:
 *
 *   search → release page for the wanted version → variant page (nodpi / bundle)
 *          → download page carrying a one-time key → POST to download.php
 *          → 302 → file
 *
 * Every step is capped and every failure is reported with the page to open by
 * hand, because Cloudflare challenges and layout changes are normal here.
 */

const MAX_RELEASES = 3;

export interface ApkMirrorOptions {
  /** Overridden by tests to point at a local mirror. */
  site?: string;
}
const MAX_VARIANTS = 3;
const PAGE_HEADERS = { 'user-agent': BROWSER_HEADERS['user-agent']! };

interface Fetched {
  html: string;
  finalUrl: string;
  status: number;
}

export class ApkMirrorProvider implements Provider {
  readonly id = 'apkmirror';
  readonly label = 'APKMirror';
  readonly description = 'The deepest archive of historical app versions. Scraped page by page — best effort.';
  readonly homepage = 'https://www.apkmirror.com';
  readonly kind = 'file' as const;
  readonly notes = [
    'First choice for YouTube / YouTube Music / Reddit builds, which is what most patches target.',
    'Cloudflare may challenge automated requests; the job log reports exactly which step was blocked.',
    'Only download apps you are licensed to use.',
  ];

  private readonly site: string;

  constructor(options: ApkMirrorOptions = {}) {
    this.site = options.site ?? SITE;
  }

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    const jar = new CookieJar();
    const pages: CandidatePage[] = [];
    const notes: string[] = [];

    const query = context.versionName ? `${context.packageName} ${context.versionName}` : context.packageName;
    const startUrl = searchUrl(query, this.site);
    pages.push({ url: startUrl, label: 'APKMirror search' });

    const search = await this.fetch(startUrl, jar);
    if (!search) {
      return emptyResult('APKMirror could not be reached at all (no response from www.apkmirror.com).');
    }
    if (looksBlocked(search.html, search.status)) {
      return {
        files: [],
        pages,
        detail: 'APKMirror answered with a Cloudflare challenge instead of the page — open the search link in a browser.',
      };
    }

    notes.push(`search returned ${search.html.length.toLocaleString('en-US')} bytes`);

    // Release pages for the requested version, or any release page as a fallback.
    let releases = pickReleaseLinks(search.html, search.finalUrl, context.versionName);
    if (!releases.length && context.packageName) {
      const appPage = this.pickAppPage(search.html, search.finalUrl);
      if (appPage) {
        pages.push({ url: appPage, label: 'APKMirror app page' });
        const app = await this.fetch(appPage, jar);
        if (app) {
          releases = pickReleaseLinks(app.html, app.finalUrl, context.versionName);
          if (!releases.length) {
            // The app page lists only the newest uploads; fall back to them and let
            // verification decide whether the version is right.
            releases = pickReleaseLinks(app.html, app.finalUrl, null).slice(0, MAX_RELEASES);
          }
        }
      }
    }

    if (!releases.length) {
      return {
        files: [],
        pages,
        detail: context.versionName
          ? `No release page mentions ${context.versionName}; it may not be archived.`
          : 'No release pages found on the search page.',
      };
    }

    notes.push(`${releases.length} release page(s)`);
    for (const release of releases.slice(0, MAX_RELEASES)) {
      pages.push({ url: release.url, label: `APKMirror release: ${release.text || release.url.split('/').at(-2) || 'page'}` });
    }

    const files: CandidateFile[] = [];

    for (const release of releases.slice(0, MAX_RELEASES)) {
      const page = await this.fetch(release.url, jar, startUrl);
      if (!page) continue;
      if (looksBlocked(page.html, page.status)) {
        notes.push('release page blocked');
        continue;
      }

      // Some releases link straight at a keyed download page.
      const keyed = pickKeyedDownloadLinks(page.html, page.finalUrl);
      const variants = pickVariantLinks(page.html, page.finalUrl).sort(
        (a, b) => scoreVariant(b, context.fileType, context.preferAbi) - scoreVariant(a, context.fileType, context.preferAbi),
      );

      if (!variants.length && !keyed.length) {
        notes.push(`no download links on ${release.text || 'release page'}`);
        continue;
      }

      notes.push(`${variants.length} variant(s)`);

      // Variant page → download page (keyed) → POST.
      for (const variant of variants.slice(0, MAX_VARIANTS)) {
        pages.push({ url: variant.url, label: `APKMirror variant: ${variant.text || 'download'}` });
        const variantPage = await this.fetch(variant.url, jar, release.url);
        if (!variantPage) continue;

        const keyedOnVariant = pickKeyedDownloadLinks(variantPage.html, variantPage.finalUrl);
        for (const downloadPageUrl of [...keyedOnVariant, ...keyed].slice(0, 2)) {
          const file = await this.submitDownloadForm(downloadPageUrl.url, jar, variant.url, notes, context);
          if (file) files.push({ url: file, label: `APKMirror ${variant.text || 'download'}`, headers: { referer: downloadPageUrl.url } });
        }

        // A plain .apk link on the variant page needs nothing else.
        for (const direct of pickDirectFileLinks(variantPage.html, variantPage.finalUrl)) {
          files.push({ url: direct, label: 'APKMirror direct file link' });
        }

        if (files.length >= MAX_VARIANTS) break;
      }

      if (files.length) break;
    }

    if (!files.length) {
      return {
        files,
        pages,
        detail: `APKMirror: ${notes.join('; ')} — no file link could be extracted, open one of the pages to grab it by hand.`,
      };
    }

    return { files, pages, detail: `APKMirror: ${notes.join('; ')}; ${files.length} candidate link(s).` };
  }

  private pickAppPage(html: string, baseUrl: string): string | null {
    const match = /href="(\/apk\/[^"?#]+\/[^"?#]+\/?)"/i.exec(html);
    if (!match) return null;
    try {
      return new URL(match[1]!, baseUrl).toString();
    } catch {
      return null;
    }
  }

  private async fetch(url: string, jar: CookieJar, referer?: string): Promise<Fetched | null> {
    try {
      const cookie = jar.header(url);
      const response = await request(url, {
        timeoutMs: 20_000,
        redirect: 'follow',
        headers: {
          ...PAGE_HEADERS,
          ...(referer ? { referer } : {}),
          ...(cookie ? { cookie } : {}),
        },
      });
      jar.absorb(url, response);
      const html = await response.text();
      return { html, finalUrl: response.url || url, status: response.status };
    } catch (error) {
      if (error instanceof HttpError) return null;
      return null;
    }
  }

  /** Opens a keyed download page and posts its form, following the redirect to the file. */
  private async submitDownloadForm(
    downloadPageUrl: string,
    jar: CookieJar,
    referer: string,
    notes: string[],
    context: ResolveContext,
  ): Promise<string | null> {
    const page = await this.fetch(downloadPageUrl, jar, referer);
    if (!page) return null;
    if (looksBlocked(page.html, page.status)) {
      notes.push('download page blocked');
      return null;
    }

    const form = pickDownloadForm(page.html, page.finalUrl);
    if (!form) {
      const direct = pickDirectFileLinks(page.html, page.finalUrl)[0];
      if (direct) return direct;
      notes.push('download page had no form');
      return null;
    }

    try {
      const body = new URLSearchParams();
      for (const field of form.fields) body.append(field.name, field.value);

      const cookie = jar.header(form.action);
      const response = await request(form.action, {
        method: 'POST',
        redirect: 'manual',
        timeoutMs: 30_000,
        headers: {
          ...PAGE_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          referer: page.finalUrl,
          ...(cookie ? { cookie } : {}),
        },
        body: body.toString(),
      });
      await response.body?.cancel().catch(() => undefined);
      jar.absorb(form.action, response);

      const location = response.headers.get('location');
      if (!location) {
        notes.push(`download form answered HTTP ${response.status} without a file`);
        return null;
      }
      const target = new URL(location, form.action).toString();
      if (/\.php(\?|$)/.test(new URL(target).pathname) && !/\.(apk|apkm|apks|xapk)(\?|$)/i.test(target)) {
        notes.push('download redirected back to a page, not a file');
        return null;
      }
      return target;
    } catch (error) {
      context.log('warn', `APKMirror download form failed: ${(error as Error).message}`);
      return null;
    }
  }
}

/** Links that point straight at a package file, ignoring ad/tracking redirects. */
function pickDirectFileLinks(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const baseHost = new URL(baseUrl).host;
  const pattern = /href="([^"]+\.(?:apk|apkm|apks|xapk)(?:\?[^"]*)?)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const url = new URL(match[1]!, baseUrl).toString();
      const host = new URL(url).host;
      if (host === baseHost || host.endsWith('apkmirror.com')) urls.add(url);
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...urls];
}
