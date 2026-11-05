import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileNameFromResponse, HttpError, request } from './http.ts';
import type { CandidateFile } from './providers/types.ts';

export const MAX_DOWNLOAD_BYTES = 2.5 * 1024 * 1024 * 1024;

export interface DownloadProgress {
  bytesReceived: number;
  bytesTotal: number | null;
}

export interface DownloadOutcome {
  path: string;
  fileName: string;
  url: string;
  bytes: number;
}

export class DownloadError extends Error {}

/**
 * Streams a candidate file to disk.
 *
 * Mirrors fail in specific ways worth naming: a 403 from Cloudflare, an HTML
 * interstitial instead of an APK, a redirect to a login page, or a truncated
 * body. Each turns into a DownloadError whose message ends up in the job log.
 */
export async function downloadCandidate(
  candidate: CandidateFile,
  directory: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
    timeoutMs?: number;
  } = {},
): Promise<DownloadOutcome> {
  await mkdir(directory, { recursive: true });

  if (candidate.localPath) {
    const info = await stat(candidate.localPath);
    if (info.size > MAX_DOWNLOAD_BYTES) throw new DownloadError('File is too large to copy');
    const target = join(directory, candidate.localPath.split('/').pop() ?? 'local.apk');
    let received = 0;
    const source = createReadStream(candidate.localPath);
    source.on('data', (chunk) => {
      received += typeof chunk === 'string' ? chunk.length : chunk.length;
      options.onProgress?.({ bytesReceived: received, bytesTotal: info.size });
    });
    await pipeline(source, createWriteStream(target));
    return {
      path: target,
      fileName: candidate.localPath.split('/').pop() ?? 'local.apk',
      url: candidate.url,
      bytes: info.size,
    };
  }

  let response: Response;
  try {
    response = await request(candidate.url, {
      headers: {
        accept: '*/*',
        ...(candidate.headers ?? {}),
      },
      redirect: 'follow',
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new DownloadError('Cancelled');
    throw new DownloadError((error as Error).message);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const detail =
      response.status === 403
        ? 'the mirror refused the download (HTTP 403 — usually Cloudflare or a region block)'
        : response.status === 404
          ? 'the file no longer exists at that URL (HTTP 404)'
          : `the server answered HTTP ${response.status}`;
    throw new DownloadError(`Could not download: ${detail}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && /text\/html|application\/json|text\/plain/i.test(contentType)) {
    const preview = await response.text().catch(() => '');
    const hint = /cloudflare|challenge|captcha|attention required/i.test(preview)
      ? 'a Cloudflare challenge page'
      : /sign in|login|log in/i.test(preview)
        ? 'a login page'
        : 'an HTML page instead of a file';
    throw new DownloadError(`The mirror returned ${hint} (content-type ${contentType})`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? '');
  const bytesTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  if (bytesTotal != null && bytesTotal > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadError(`File is too large (${bytesTotal} bytes)`);
  }

  const fileName =
    fileNameFromResponse(response.url, response.headers.get('content-disposition')) ??
    candidate.url.split('/').pop()?.split('?')[0] ??
    'download.bin';
  const target = join(directory, `${Date.now().toString(36)}-${fileName.replace(/[^\w.-]+/g, '_')}`);
  const partial = `${target}.part`;

  if (!response.body) throw new DownloadError('The mirror sent an empty response');

  let received = 0;
  const source = response.body as unknown as AsyncIterable<Uint8Array>;
  const sink = createWriteStream(partial);
  const counted = (async function* count() {
    for await (const chunk of source) {
      received += chunk.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw new DownloadError('Download exceeded the size limit');
      options.onProgress?.({ bytesReceived: received, bytesTotal });
      yield chunk;
    }
  })();

  try {
    await pipeline(counted, sink);
  } catch (error) {
    await rm(partial, { force: true });
    if (options.signal?.aborted) throw new DownloadError('Cancelled');
    throw new DownloadError(`Download failed after ${received} bytes: ${(error as Error).message}`);
  }

  if (received === 0) {
    await rm(partial, { force: true });
    throw new DownloadError('The mirror sent an empty file');
  }

  await rename(partial, target);
  return { path: target, fileName, url: candidate.url, bytes: received };
}

export function describeDownloadError(error: unknown): string {
  if (error instanceof DownloadError || error instanceof HttpError) return error.message;
  return (error as Error).message;
}
