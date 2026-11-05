import { resolveRedirects } from '../http.ts';
import { findFileLinks } from './scrape.ts';
import { emptyResult, type CandidatePage, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * api.morphe.software is the service Morphe Manager itself uses to answer "where
 * do I get version X of this app?". It answers with a redirect to a mirror page.
 *
 * PatchPilot asks the same question and then does the extra work Morphe Manager
 * leaves to the user: crawling that page for a direct file, and reporting it as a
 * page to open when the file cannot be fetched programmatically.
 */

const API = 'https://api.morphe.software';

export class MorpheApiProvider implements Provider {
  readonly id = 'morphe-api';
  readonly label = 'Morphe download helper';
  readonly description = 'The official Morphe service that points at a mirror page for a given app version.';
  readonly homepage = 'https://github.com/MorpheApp/morphe-manager';
  readonly kind = 'page' as const;
  readonly notes = [
    'Returns a web page, not always a file: PatchPilot crawls it for a direct download first.',
    'This is the same lookup Morphe Manager performs in-app.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    if (!context.versionName) {
      return emptyResult('The Morphe helper needs a specific version to look up.');
    }

    const abi = context.preferAbi ?? 'arm64-v8a';
    const query = `${context.packageName}~${context.versionName}~${abi}`;
    const apiUrl = `${API}/v2/web-search/${query}`;

    const { finalUrl, chain } = await resolveRedirects(apiUrl, 6, 12_000);
    context.log('info', `Morphe helper redirect chain: ${chain.map((url) => new URL(url).host).join(' → ')}`);

    if (finalUrl === apiUrl) {
      return emptyResult('The Morphe helper did not answer with a redirect (service unreachable or unknown query).');
    }

    const pages: CandidatePage[] = [{ url: finalUrl, label: `Morphe helper → ${new URL(finalUrl).host}` }];

    if (/\.(apk|apkm|apks|xapk)(\?|$)/i.test(finalUrl)) {
      return {
        files: [{ url: finalUrl, label: `Morphe helper → direct file on ${new URL(finalUrl).host}` }],
        pages,
        detail: `Morphe helper pointed straight at a file on ${new URL(finalUrl).host}.`,
      };
    }

    // Mirror page: look for a direct file link before giving up.
    try {
      const response = await fetch(finalUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const html = await response.text();
        const files = findFileLinks(html, finalUrl)
          .filter((link) => /\.(apk|apkm|apks|xapk)$/i.test(new URL(link.url).pathname))
          .slice(0, 5)
          .map((link) => ({ url: link.url, label: `From ${new URL(finalUrl).host}: ${link.text || 'file'}` }));
        if (files.length) {
          return { files, pages, detail: `Morphe helper → ${new URL(finalUrl).host}, found ${files.length} direct file link(s).` };
        }
      }
    } catch {
      // The page can still be opened by hand.
    }

    return {
      files: [],
      pages,
      detail: `Morphe helper points at ${new URL(finalUrl).host}; open that page to pick the file.`,
    };
  }
}
