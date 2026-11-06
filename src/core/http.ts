import { buildUserAgent } from '../shared/userAgent.ts';

/**
 * HTTP helpers with predictable timeouts and error messages.
 *
 * PatchPilot talks to GitHub, to APK mirrors and to api.morphe.software. Mirrors
 * are often behind Cloudflare, rate limits or geo-blocks, so every failure has to
 * come back as a sentence a person can act on rather than "fetch failed".
 */

/**
 * The server sets this to its real version. The Android build sets it at
 * startup too, so mirror operators see one consistent client either way.
 */
let userAgent = buildUserAgent('dev');
export function setUserAgent(value: string): void {
  userAgent = value;
}

/**
 * The transport is swappable so the same provider code can run against the
 * platform fetch on a server and through the Android shell on a phone, where
 * the WebView cannot reach mirror hosts directly (CORS) and the shell owns the
 * sockets. Tests use it too.
 */
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (input, init) => fetch(input, init);

export function setFetchImplementation(implementation: Fetcher): void {
  fetcher = implementation;
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Extra headers merged over the default browser-ish set. */
  headers?: Record<string, string>;
}

export const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function describeNetworkError(error: unknown, url: string): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (error as NodeJS.ErrnoException).code;
  const host = new URL(url).host;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve ${host} (DNS). Check this machine's internet connection.`;
    case 'ECONNREFUSED':
      return `${host} refused the connection.`;
    case 'ECONNRESET':
      return `${host} reset the connection.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return `${host} did not answer in time.`;
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS verification failed for ${host}.`;
    default:
      if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError') {
        return `${host} did not answer in time.`;
      }
      return `Request to ${host} failed: ${cause?.message ?? (error as Error).message}`;
  }
}

export async function request(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 20_000, headers, ...init } = options;
  try {
    return await fetcher(url, {
      ...init,
      redirect: init.redirect ?? 'follow',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...BROWSER_HEADERS,
        'user-agent': userAgent,
        ...headers,
      },
    });
  } catch (error) {
    throw new HttpError(describeNetworkError(error, url), null, url, true);
  }
}

async function ensureOk(response: Response, url: string): Promise<Response> {
  if (response.ok) return response;
  const detail =
    response.status === 403
      ? 'Access denied — the site is blocking automated requests (Cloudflare or geo-block).'
      : response.status === 404
        ? 'Not found.'
        : response.status === 429
          ? 'Rate limited — try again later.'
          : `Unexpected HTTP ${response.status}.`;
  throw new HttpError(`${detail} (${url})`, response.status, url, response.status === 429 || response.status >= 500);
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await ensureOk(await request(url, withJsonHeaders(url, options)), url);
  return response.text();
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(`Expected JSON from ${url} but got something else`, null, url);
  }
}

function withJsonHeaders(url: string, options: FetchOptions): FetchOptions {
  if (!url.endsWith('.json')) return options;
  return { ...options, headers: { accept: 'application/json', ...options.headers } };
}

/**
 * Follows a redirect chain without downloading the body, and reports where it
 * ends up. Used to identify which mirror a page link points at.
 */
export async function resolveRedirects(url: string, maxHops = 6, timeoutMs = 12_000): Promise<{ finalUrl: string; chain: string[] }> {
  const chain: string[] = [url];
  let current = url;

  for (let hop = 0; hop < maxHops; hop++) {
    let response: Response;
    try {
      response = await request(current, { method: 'GET', redirect: 'manual', timeoutMs });
    } catch {
      return { finalUrl: current, chain };
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || response.status < 300 || response.status >= 400) {
      return { finalUrl: current, chain };
    }
    current = new URL(location, current).toString();
    chain.push(current);
  }

  return { finalUrl: current, chain };
}

export function isHtml(contentType: string | null): boolean {
  return (contentType ?? '').includes('html');
}

export function fileNameFromResponse(url: string, contentDisposition: string | null): string | null {
  if (contentDisposition) {
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (encoded) {
      try {
        return decodeURIComponent(encoded[1]);
      } catch {
        // fall through
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (plain) return plain[1];
  }
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').filter(Boolean).pop();
    if (base && /\.(apk|apkm|xapk|apks|zip)$/i.test(base)) return base;
  } catch {
    // ignore
  }
  return null;
}

/** Small cookie jar: mirrors hand out session cookies that later requests need. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(url: string, response: Response): void {
    const host = new URL(url).host;
    const values = response.headers.getSetCookie?.() ?? [];
    for (const value of values) {
      const [pair] = value.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const cookieValue = pair.slice(index + 1).trim();
      this.cookies.set(`${host}|${name}`, cookieValue);
    }
  }

  header(url: string): string | undefined {
    const host = new URL(url).host;
    const parts: string[] = [];
    for (const [key, value] of this.cookies) {
      const [cookieHost, name] = key.split('|');
      if (cookieHost === host) parts.push(`${name}=${value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }
}
