/**
 * The bridge between the web UI and the Android shell.
 *
 * In the Android app there is no server: this module is the only thing that can
 * reach the network (the WebView's own fetches are subject to CORS, and the APK
 * mirrors do not send CORS headers), touch a file, or ask Android what an APK
 * actually is. Everything above this layer is ordinary TypeScript.
 *
 * The Java side exposes exactly one method — `call(id, action, payloadJson)` —
 * and answers through `window.__patchpilotBridge.resolve(id, json)` /
 * `.event(id, json)`, which keeps the Java surface small enough to review.
 */

export interface NativeHttpResponse {
  status: number;
  /** Header name → all values, lower-cased keys; `set-cookie` survives here. */
  headers: Record<string, string[]>;
  bodyBase64: string;
}

export interface NativeDownloadResult {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface NativeApkInfo {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  signerSha256: string[];
  signingSchemes: string[];
  isSplit: boolean;
  sizeBytes: number;
  minSdk: number | null;
  targetSdk: number | null;
  /** Set by `apk.inspectBytes`: where the shell put the temporary copy. */
  tempPath?: string | null;
  /** APK entry names inside a split bundle. */
  splits?: string[];
}

export interface NativeLibraryFile {
  /** Stable id: the file name inside Downloads/PatchPilot. */
  name: string;
  /** Opaque handle the shell can reopen or delete later (a path or a URI). */
  handle: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface NativeDevice {
  version: string;
  sdk: number;
  model: string;
  /** `Build.SUPPORTED_ABIS`, most preferred first. */
  abis?: string[];
}

export interface NativeBridge {
  call(action: string, payload: unknown, onEvent?: (event: Record<string, unknown>) => void): Promise<unknown>;
}

export interface DeviceState {
  freeBytes: number;
  totalBytes: number;
  installAllowed: boolean;
  notifications: boolean;
}

export interface DownloadProgress {
  bytesReceived: number;
  bytesTotal: number | null;
}

/* ------------------------------------------------------------------ base64 --- */

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* ------------------------------------------------------------------ facade --- */

export class Native {
  constructor(
    readonly bridge: NativeBridge,
    readonly device: NativeDevice,
  ) {}

  async http(request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | null;
    /** `false` when the caller wants the 3xx back instead of its destination. */
    followRedirects?: boolean;
  }): Promise<NativeHttpResponse> {
    return this.bridge.call('net.request', {
      url: request.url,
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      bodyBase64: request.body ? toBase64(request.body) : null,
      followRedirects: request.followRedirects !== false,
    }) as Promise<NativeHttpResponse>;
  }

  async download(
    request: { url: string; fileName?: string; headers?: Record<string, string> },
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<NativeDownloadResult> {
    return this.bridge.call(
      'net.download',
      { url: request.url, fileName: request.fileName ?? null, headers: request.headers ?? {} },
      (event) => {
        if (!onProgress) return;
        onProgress({
          bytesReceived: Number(event.bytesReceived ?? 0),
          bytesTotal: event.bytesTotal == null ? null : Number(event.bytesTotal),
        });
      },
    ) as Promise<NativeDownloadResult>;
  }

  async inspect(path: string): Promise<NativeApkInfo> {
    return this.bridge.call('apk.inspect', { path }) as Promise<NativeApkInfo>;
  }

  async inspectBytes(name: string, bytes: Uint8Array): Promise<NativeApkInfo> {
    return this.bridge.call('apk.inspectBytes', { name, base64: toBase64(bytes) }) as Promise<NativeApkInfo>;
  }

  async publish(path: string, name: string): Promise<NativeLibraryFile> {
    return this.bridge.call('library.publish', { path, name }) as Promise<NativeLibraryFile>;
  }

  async listLibrary(): Promise<NativeLibraryFile[]> {
    return this.bridge.call('library.list', {}) as Promise<NativeLibraryFile[]>;
  }

  async deleteLibraryFile(handle: string): Promise<boolean> {
    return this.bridge.call('library.delete', { handle }) as Promise<boolean>;
  }

  async deleteTemp(path: string): Promise<void> {
    await this.bridge.call('files.delete', { path });
  }

  async getStore(key: string): Promise<string | null> {
    return this.bridge.call('store.get', { key }) as Promise<string | null>;
  }

  async setStore(key: string, value: string): Promise<void> {
    await this.bridge.call('store.set', { key, value });
  }

  async openUrl(url: string): Promise<void> {
    await this.bridge.call('open.url', { url });
  }

  async toast(message: string): Promise<void> {
    await this.bridge.call('ui.toast', { message });
  }

  /** Storage, install permission and notification state, for the Doctor. */
  async state(): Promise<DeviceState> {
    return this.bridge.call('device.state', {}) as Promise<DeviceState>;
  }

  /** Opens Morphe Manager, if a known package for it is installed. */
  async openMorphe(): Promise<{ package: string | null }> {
    return this.bridge.call('app.openMorphe', {}) as Promise<{ package: string | null }>;
  }

  /** Hands a saved APK to the system installer. */
  async installApk(handle: string, name: string): Promise<void> {
    await this.bridge.call('apk.install', { handle, name });
  }
}

/* -------------------------------------------------- the Android implementation --- */

interface JavaShell {
  call(id: string, action: string, payloadJson: string): void;
}

/**
 * Wraps the `@JavascriptInterface` object. The Java side must call
 * `window.__patchpilotBridge.resolve(id, json)` / `.event(id, json)`; anything
 * it throws comes back as a rejected promise with the Java message.
 */
export function androidBridge(shell: JavaShell): NativeBridge {
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      onEvent?: (event: Record<string, unknown>) => void;
    }
  >();
  let counter = 0;

  (window as unknown as { __patchpilotBridge: unknown }).__patchpilotBridge = {
    resolve(id: string, json: string) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      try {
        const parsed = JSON.parse(json) as { ok: boolean; value?: unknown; error?: string };
        if (parsed.ok) entry.resolve(parsed.value ?? null);
        else entry.reject(new Error(parsed.error ?? 'The Android layer refused the request.'));
      } catch (error) {
        entry.reject(error as Error);
      }
    },
    event(id: string, json: string) {
      const entry = pending.get(id);
      if (!entry?.onEvent) return;
      try {
        entry.onEvent(JSON.parse(json) as Record<string, unknown>);
      } catch {
        // A malformed progress frame must never break the job.
      }
    },
  };

  return {
    call(action, payload, onEvent) {
      return new Promise((resolve, reject) => {
        counter += 1;
        const id = `c${counter}`;
        pending.set(id, { resolve, reject, onEvent });
        try {
          shell.call(id, action, JSON.stringify(payload ?? {}));
        } catch (error) {
          pending.delete(id);
          reject(error as Error);
        }
      });
    },
  };
}

/** True when the page is running inside the Android shell. */
export function hasAndroidShell(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { PatchPilotNative?: unknown }).PatchPilotNative);
}

export function androidDevice(): NativeDevice {
  const shell = (window as unknown as { PatchPilotNative?: { deviceJson?: () => string } }).PatchPilotNative;
  try {
    const raw = shell?.deviceJson?.();
    if (raw) return JSON.parse(raw) as NativeDevice;
  } catch {
    // fall through to the generic answer
  }
  return { version: '0.0.0', sdk: 0, model: 'Android' };
}
