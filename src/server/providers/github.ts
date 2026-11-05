import githubApps from '../../../config/github-apps.json' with { type: 'json' };
import { PROJECT_URL, buildUserAgent } from '../../shared/userAgent.ts';
import { fetchJson, HttpError } from '../http.ts';
import { pageMentionsVersion } from './scrape.ts';
import { emptyResult, type CandidateFile, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * Apps that publish their own APKs in GitHub releases.
 *
 * Patch bundles only name packages, never repositories, so the mapping lives in
 * `config/github-apps.json` — a small file users can extend when a patched app is
 * distributed on GitHub.
 */

interface GithubMapping {
  repo: string;
  /** Regex an asset name must match, e.g. "universal". */
  assetPattern?: string;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type?: string;
}

interface Release {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
}

const headers = (): Record<string, string> => {
  // `process` does not exist in the WebView build; there is no token there either.
  const env = typeof process === 'undefined' ? undefined : process.env;
  const token = env?.GITHUB_TOKEN ?? env?.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
};

/**
 * The mapping is imported rather than read at runtime so the same code runs in
 * the Node server and in the Android app, where there is no repository folder to
 * read from. Edit config/github-apps.json and rebuild to add an app.
 */
export async function loadGithubMappings(): Promise<Record<string, GithubMapping>> {
  return (githubApps as { apps?: Record<string, GithubMapping> }).apps ?? {};
}

const APK_ASSET = /\.(apk|apkm|apks|xapk)$/i;

export class GithubReleasesProvider implements Provider {
  readonly id = 'github';
  readonly label = 'GitHub releases';
  readonly description = 'Downloads APKs that projects attach to their own GitHub releases.';
  readonly homepage = 'https://github.com';
  readonly kind = 'file' as const;
  readonly notes = [
    'Only works for apps whose maintainers ship APKs on GitHub.',
    'Add your own entry to config/github-apps.json to cover more apps.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    const mappings = await loadGithubMappings();
    const mapping = mappings[context.packageName];
    if (!mapping) {
      return emptyResult('No GitHub repository is configured for this package.');
    }

    const releases = await fetchJson<Release[]>(
      `https://api.github.com/repos/${mapping.repo}/releases?per_page=30`,
      { headers: { ...headers(), accept: 'application/vnd.github+json', 'user-agent': buildUserAgent('app') }, timeoutMs: 20_000 },
    ).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return [] as Release[];
      throw error;
    });

    const usable = releases.filter((release) => !release.draft && release.assets.some((asset) => APK_ASSET.test(asset.name)));
    if (!usable.length) {
      return emptyResult(`${mapping.repo} has no releases with APK assets.`);
    }

    const files: CandidateFile[] = [];
    const assetPattern = mapping.assetPattern ? new RegExp(mapping.assetPattern, 'i') : null;

    for (const release of usable) {
      const tagMatches =
        context.versionName != null &&
        (release.tag_name.includes(context.versionName) ||
          (release.name != null && release.name.includes(context.versionName)));

      for (const asset of release.assets) {
        if (!APK_ASSET.test(asset.name)) continue;
        if (assetPattern && !assetPattern.test(asset.name)) continue;
        if (context.versionName && !tagMatches && !pageMentionsVersion(asset.name, context.versionName)) continue;
        files.push({
          url: asset.browser_download_url,
          label: `${mapping.repo} ${release.tag_name} · ${asset.name}`,
          headers: { accept: 'application/octet-stream' },
        });
      }
    }

    if (!files.length) {
      return emptyResult(
        `${mapping.repo} publishes ${usable.length} release(s) with APKs, none for ${context.versionName ?? 'this version'}.`,
      );
    }

    context.log('info', `GitHub matched ${files.length} asset(s) in ${mapping.repo}`);
    return { files, pages: [], detail: `Found APK assets in ${mapping.repo}.` };
  }
}
