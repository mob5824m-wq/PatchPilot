import { fetchJson } from '../http.ts';
import { emptyResult, type Provider, type ProviderResult, type ResolveContext } from './types.ts';

/**
 * F-Droid hands out exact builds by version code, with no login, no Cloudflare
 * and no ambiguity about which version a URL returns — the most dependable APK
 * source there is, for the apps F-Droid happens to carry.
 */

interface FdroidPackage {
  packageName?: string;
  versions?: { versionCode?: number; versionName?: string }[];
}

export class FdroidProvider implements Provider {
  readonly id = 'fdroid';
  readonly label = 'F-Droid';
  readonly description = 'Official F-Droid repository: exact builds by version code, open API.';
  readonly homepage = 'https://f-droid.org';
  readonly kind = 'file' as const;
  readonly notes = [
    'Only covers apps published on F-Droid, which is a minority of patched apps.',
    'Downloads are unmodified and signed by the upstream developer.',
  ];

  async resolve(context: ResolveContext): Promise<ProviderResult> {
    let data: FdroidPackage;
    try {
      data = await fetchJson<FdroidPackage>(
        `https://f-droid.org/api/v1/packages/${encodeURIComponent(context.packageName)}`,
        { timeoutMs: 15_000 },
      );
    } catch {
      return emptyResult('Not an F-Droid package (no entry in the F-Droid index).');
    }

    const versions = data.versions ?? [];
    if (!versions.length) return emptyResult('F-Droid lists no downloadable versions for this package.');

    const wanted =
      (context.versionName ? versions.filter((entry) => entry.versionName === context.versionName) : []) ?? [];

    const codes = context.versionCodes ? Object.values(context.versionCodes) : [];
    const byCode = versions.filter((entry) => entry.versionCode != null && codes.includes(entry.versionCode));

    const matches = [...wanted, ...byCode];
    if (!matches.length) {
      return emptyResult(
        context.versionName
          ? `F-Droid has ${versions.length} version(s) of this app, but not ${context.versionName}.`
          : 'F-Droid lists versions for this app, but none matched.',
      );
    }

    const files = matches
      .filter((entry, index) => matches.indexOf(entry) === index)
      .map((entry) => ({
        url: `https://f-droid.org/repo/${context.packageName}_${entry.versionCode}.apk`,
        label: `F-Droid ${entry.versionName ?? ''} (versionCode ${entry.versionCode})`,
        expectedVersionCode: entry.versionCode ?? null,
      }));

    context.log('info', `F-Droid matched ${files.length} build(s) for ${context.packageName}`);
    return { files, pages: [], detail: `F-Droid listed a build for this version.` };
  }
}
