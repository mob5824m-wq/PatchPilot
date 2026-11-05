import type { ApkFileType } from '../../shared/types.ts';
import { BROWSER_HEADERS, CookieJar, fetchText, HttpError, request } from '../http.ts';
import { extractForms, extractLinks, findFileLinks, pageMentionsVersion, stripTags } from './scrape.ts';
import { emptyResult, type CandidateFile, type CandidatePage, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * APKMirror has every version of almost every popular app, and no API. This
 * provider walks the site the way a person would: search, open the release page
 * for the requested version, open a variant page, submit its download form and
 * take the file it redirects to.
 *
 * It is deliberately defensive. Cloudflare answers datacenter IPs with a
 * challenge, layouts change, and a variant page may not exist for the file type
 * the patches need — every step reports what it saw, and anything that cannot be
 * resolved becomes a page link the user can open in a browser instead.
 */

const SEARCH = (query: string) =>
  `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${encodeURIComponent(query)}`;

const MAX_VARIANTS = 4;

/** Scraped pages are served to browsers; present as one. */
const PAGE_HEADERS = { 'user-agent': BROWSER_HEADERS['user-agent']! };

interface Variant {
  url: string;
  text: string;
}

function variantScore(url: string, text: string, fileType: ApkFileType | null, preferAbi: string | null): number {
  const haystack = `${url} ${text}`.toLowerCase();
  let score = 0;
  const wantsBundle = fileType === 'APKM' || fileType === 'APKS' || fileType === 'APKS_REQUIRED' || fileType === 'XAPK' || fileType === 'XAPK_REQUIRED';

  if (wantsBundle) {
    if (/bundle|split/.test(haystack)) score += 6;
  } else {
    if (/nodpi|universal/.test(haystack)) score += 4;
    if (/bundle|split/.test(haystack)) score -= 4;
  }
  if (preferAbi) {
    const abi = preferAbi.toLowerCase().replace(/_/g, '-');
    if (haystack.includes(abi)) score += 3;
    else if (/arm64-v8a|armeabi-v7a|x86_64|x86/.test(haystack)) score -= 1;
  }
  if (/nodpi/.test(haystack)) score += 1;
  return score;
}

export class ApkMirrorProvider implements Provider {
  readonly id = 'apkmirror';
  readonly label = 'APKMirror';
  readonly description = 'Largest version archive for popular apps. Scraped, no API — best effort.';
  readonly homepage = 'https://www.apkmirror.com';
  readonly kind = 'file' as const;
  readonly notes = [
    'Cloudflare may answer with a challenge; the job log reports when that happens.',
    'Only use this for apps whose licence lets you download them.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    const jar = new CookieJar();
    const pages: CandidatePage[] = [];
    const details: string[] = [];

    const query = context.versionName ? `${context.packageName} ${context.versionName}` : context.packageName;
    const searchUrl = SEARCH(query);
    pages.push({ url: searchUrl, label: 'APKMirror search' });

    let searchHtml: string;
    try {
      const response = await request(searchUrl, { timeoutMs: 20_000, headers: PAGE_HEADERS });
      jar.absorb(searchUrl, response);
      if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status, searchUrl);
      searchHtml = await response.text();
    } catch (error) {
      const message = error instanceof HttpError ? error.message : (error as Error).message;
      if (/403|challenge|cloudflare/i.test(message)) {
        return emptyResult('APKMirror blocked the request (Cloudflare). Open the search page in a browser instead.');
      }
      return emptyResult(`Could not reach APKMirror: ${message}`);
    }

    if (/cf-challenge|Just a moment/i.test(searchHtml)) {
      return emptyResult('APKMirror served a Cloudflare challenge instead of the page.');
    }

    const links = extractLinks(searchHtml, searchUrl).filter((link) => link.url.includes('apkmirror.com/apk/'));
    const releaseLinks = links.filter((link) => /-release\/?$/.test(new URL(link.url).pathname));
    const appLinks = links.filter((link) => !releaseLinks.includes(link));

    const matchingReleases = releaseLinks.filter((link) => {
      if (!context.versionName) return true;
      const path = decodeURIComponent(new URL(link.url).pathname).replace(/[^0-9a-z.]+/gi, ' ');
      return pageMentionsVersion(path, context.versionName) || pageMentionsVersion(link.text, context.versionName);
    });

    details.push(
      `${releaseLinks.length} release link(s) on the search page${matchingReleases.length ? `, ${matchingReleases.length} mention ${context.versionName}` : ''}`,
    );

    const releaseCandidates = matchingReleases.length ? matchingReleases : releaseLinks.slice(0, 3);
    for (const link of releaseCandidates.slice(0, 3)) pages.push({ url: link.url, label: `APKMirror release: ${link.text || 'page'}` });

    const variants: Variant[] = [];
    for (const release of releaseCandidates.slice(0, 3)) {
      let html: string;
      try {
        html = await fetchText(release.url, { timeoutMs: 20_000, headers: { ...PAGE_HEADERS, referer: searchUrl } });
      } catch {
        continue;
      }
      const releaseLinksInner = extractLinks(html, release.url).filter((link) =>
        /-android-apk-download\/?$/.test(new URL(link.url).pathname),
      );
      if (releaseLinksInner.length) {
        for (const variant of releaseLinksInner) variants.push({ url: variant.url, text: variant.text });
      } else {
        // Some layouts link straight to a download page with a different suffix.
        const direct = findFileLinks(html, release.url);
        for (const file of direct) {
          variants.push({ url: file.url, text: file.text });
        }
      }
    }

    if (!variants.length) {
      if (appLinks.length) pages.push({ url: appLinks[0].url, label: 'APKMirror app page' });
      return {
        files: [],
        pages,
        detail: `Found no download pages${context.versionName ? ` for ${context.versionName}` : ''} — the version may not be archived.`,
      };
    }

    const scored = variants
      .map((variant) => ({ ...variant, score: variantScore(variant.url, variant.text, context.fileType, context.preferAbi) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_VARIANTS);

    const files: CandidateFile[] = [];
    for (const variant of scored) {
      pages.push({ url: variant.url, label: `APKMirror download page${variant.text ? `: ${variant.text}` : ''}` });
      try {
        const variantResponse = await request(variant.url, {
          timeoutMs: 20_000,
          headers: { ...PAGE_HEADERS, referer: releaseCandidates[0]?.url ?? searchUrl },
        });
        jar.absorb(variant.url, variantResponse);
        if (!variantResponse.ok) continue;
        const html = await variantResponse.text();

        const direct = findFileLinks(html, variant.url).filter((link) => /\.(apk|apkm|apks|xapk)$/i.test(new URL(link.url).pathname));
        for (const file of direct) {
          files.push({ url: file.url, label: `APKMirror direct link (${file.text || 'file'})` });
        }

        const forms = extractForms(html, variant.url);
        const downloadForm = forms.find((form) => form.method === 'post' && form.fields.length > 0);
        if (downloadForm && !files.length) {
          const body = new URLSearchParams();
          for (const field of downloadForm.fields) body.append(field.name, field.value);
          const post = await request(downloadForm.action, {
            method: 'POST',
            timeoutMs: 25_000,
            redirect: 'manual',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              referer: variant.url,
              ...(jar.header(downloadForm.action) ? { cookie: jar.header(downloadForm.action)! } : {}),
            },
            body: body.toString(),
          });
          const location = post.headers.get('location');
          if (location) {
            const fileUrl = new URL(location, downloadForm.action).toString();
            files.push({ url: fileUrl, label: 'APKMirror signed download link', headers: { referer: variant.url } });
          }
        }
      } catch (error) {
        context.log('warn', `APKMirror variant page failed: ${(error as Error).message}`);
      }
    }

    if (!files.length) {
      return { files, pages, detail: 'APKMirror pages were found but no download link could be extracted — open one in a browser.' };
    }

    const headline = stripTags(scored[0]!.text).slice(0, 80);
    return {
      files,
      pages,
      detail: `APKMirror: ${files.length} candidate link(s) from "${headline || 'variant page'}".`,
    };
  }
}
