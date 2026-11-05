import { fromBase64, type Native, type NativeHttpResponse } from './native.ts';

/**
 * A `fetch` implementation that performs the request in the Android shell.
 *
 * The WebView cannot talk to apkpure.com or apkmirror.com directly — the
 * mirrors send no CORS headers and the page origin is not theirs — and it also
 * cannot set a browser-looking User-Agent per request. Both are solved by
 * handing every absolute http(s) request to Java, which owns real sockets,
 * cookies and redirects, then rebuilding a Response-shaped object here.
 */

/** The little of `Headers` the rest of the codebase touches. */
export class NativeHeaders {
  private readonly map: Map<string, string[]>;

  constructor(raw: Record<string, string[]>) {
    this.map = new Map(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase())?.[0] ?? null;
  }

  getAll(name: string): string[] {
    return this.map.get(name.toLowerCase()) ?? [];
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  getSetCookie(): string[] {
    return this.getAll('set-cookie');
  }

  forEach(callback: (value: string, key: string) => void): void {
    for (const [key, values] of this.map) callback(values.join(', '), key);
  }

  entries(): IterableIterator<[string, string]> {
    return [...this.map].map(([key, values]) => [key, values.join(', ')] as [string, string]).values();
  }
}

export class NativeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: NativeHeaders;
  readonly url: string;
  readonly redirected = false;
  readonly type = 'basic';
  readonly body: { cancel: () => Promise<void>; used: boolean } = {
    used: true,
    cancel: async () => undefined,
  };
  private readonly bytes: Uint8Array;

  constructor(response: NativeHttpResponse, url: string) {
    this.status = response.status;
    this.ok = response.status >= 200 && response.status < 300;
    this.statusText = String(response.status);
    this.headers = new NativeHeaders(response.headers ?? {});
    this.url = url;
    this.bytes = fromBase64(response.bodyBase64 ?? '');
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text()) as unknown;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.bytes.length);
    copy.set(this.bytes);
    return copy.buffer;
  }

  async blob(): Promise<Blob> {
    return new Blob([await this.arrayBuffer()]);
  }

  clone(): NativeResponse {
    return this;
  }
}

/** Body accepted by `fetch` in the shapes the providers actually use. */
async function bodyBytes(body: RequestInit['body']): Promise<Uint8Array | null> {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return null;
}

export function makeProxyFetch(native: Native, realFetch: typeof fetch) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    // Relative URLs are the app's own assets and the shimmed API; leave them to
    // the WebView.
    if (!/^https?:/i.test(input)) return realFetch(input, init);

    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });

    const response = await native.http({
      url: input,
      method: init.method ?? 'GET',
      headers,
      body: await bodyBytes(init.body),
      followRedirects: init.redirect !== 'manual',
    });

    return new NativeResponse(response, input) as unknown as Response;
  };
}
