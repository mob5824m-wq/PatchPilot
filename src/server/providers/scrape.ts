/**
 * Tiny HTML helpers. Mirror sites have no APIs worth relying on, so PatchPilot
 * reads their pages the same way a browser would: pull out links, forms and
 * nearby text, then decide what looks like the file it needs.
 */

export interface Link {
  url: string;
  text: string;
  href: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html: string, baseUrl: string): Link[] {
  const links: Link[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attributes = match[1] ?? '';
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const rawHref = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
    let absolute: string;
    try {
      absolute = new URL(decodeEntities(rawHref), baseUrl).toString();
    } catch {
      continue;
    }
    links.push({
      url: absolute,
      href: decodeEntities(rawHref),
      text: stripTags(match[2] ?? '').slice(0, 200),
    });
  }
  return links;
}

const DOWNLOADABLE = /\.(apk|apkm|apks|xapk)(\?|#|$)/i;

/** Links that point straight at a package file. */
export function findFileLinks(html: string, baseUrl: string): Link[] {
  return extractLinks(html, baseUrl).filter((link) => DOWNLOADABLE.test(link.url) || DOWNLOADABLE.test(link.href));
}

export interface FormField {
  name: string;
  value: string;
}

export interface HtmlForm {
  action: string;
  method: 'get' | 'post';
  fields: FormField[];
}

export function extractForms(html: string, baseUrl: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const actionMatch = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const rawAction = actionMatch ? (actionMatch[1] ?? actionMatch[2] ?? actionMatch[3] ?? '') : '';
    const methodMatch = /\bmethod\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const method = (methodMatch?.[1] ?? methodMatch?.[2] ?? methodMatch?.[3] ?? 'get').toLowerCase() === 'post' ? 'post' : 'get';

    const fields: FormField[] = [];
    const inputPattern = /<input\b([^>]*)>/gi;
    let input: RegExpExecArray | null;
    while ((input = inputPattern.exec(body))) {
      const inputAttributes = input[1] ?? '';
      const name = attributeValue(inputAttributes, 'name');
      if (!name) continue;
      fields.push({ name, value: attributeValue(inputAttributes, 'value') ?? '' });
    }

    let action: string;
    try {
      action = new URL(rawAction || baseUrl, baseUrl).toString();
    } catch {
      action = baseUrl;
    }
    forms.push({ action, method, fields });
  }
  return forms;
}

function attributeValue(attributes: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(attributes);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/** Text of the page around a link, useful for "which variant is this" heuristics. */
export function nearbyText(html: string, needle: string, radius = 400): string {
  const index = html.indexOf(needle);
  if (index < 0) return '';
  return stripTags(html.slice(Math.max(0, index - radius), index + needle.length + radius));
}

/**
 * Version strings as they appear in page text: `21.43.523`, `26.30.05`,
 * `407.0.0.178994`. Compared loosely because sites format them inconsistently.
 */
export function versionVariants(version: string): string[] {
  const variants = new Set<string>();
  const cleaned = version.trim();
  variants.add(cleaned);
  variants.add(cleaned.replace(/\./g, '-'));
  variants.add(cleaned.replace(/-/g, '.'));
  variants.add(cleaned.replace(/[^0-9a-z]+/gi, '-'));
  return [...variants].filter((value) => value.length > 0);
}

export function pageMentionsVersion(text: string, version: string): boolean {
  const haystack = text.toLowerCase();
  return versionVariants(version).some((variant) => haystack.includes(variant.toLowerCase()));
}
