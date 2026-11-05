/**
 * Reads the JSON documents out of a `.mpp` patch bundle in the browser.
 *
 * The server can lean on `node:zlib` and random-access file reads; the Android
 * app cannot. This is a small zip reader over a byte array that supports the two
 * methods a Morphe bundle uses — stored and deflate — and decompresses with the
 * platform's own `DecompressionStream`, so no dependency is added.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = 22;
  if (view.byteLength < minimum) throw new Error('That file is too small to be a patch bundle');
  const stop = Math.max(0, view.byteLength - 65_557); // 64 KiB comment + 22 byte record
  for (let offset = view.byteLength - minimum; offset >= stop; offset--) {
    if (u32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('That file is not a zip archive — is it a Morphe patch bundle?');
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = u16(view, eocd + 10);
  let offset = u32(view, eocd + 16);
  const entries: Entry[] = [];

  for (let index = 0; index < count; index++) {
    if (u32(view, offset) !== CENTRAL_SIGNATURE) break;
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(bytes: Uint8Array, entry: Entry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(view, entry.localOffset) !== LOCAL_SIGNATURE) throw new Error(`Corrupt zip entry: ${entry.name}`);
  const nameLength = u16(view, entry.localOffset + 26);
  const extraLength = u16(view, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`Unsupported compression in ${entry.name} (method ${entry.method})`);
}

/** Everything a `.mpp` is read for: the patch list and the bundle metadata. */
export async function extractFromBundleArchive(
  bytes: Uint8Array,
): Promise<{ patchesList: unknown; bundleInfo: unknown }> {
  const entries = readEntries(bytes).filter(
    (entry) => entry.name.toLowerCase().endsWith('.json') && entry.compressedSize < 32 * 1024 * 1024,
  );
  const preferred = entries.filter((entry) => /patches-list\.json$/i.test(entry.name));
  const ordered = [...preferred, ...entries.filter((entry) => !preferred.includes(entry))];

  let patchesList: unknown = null;
  let bundleInfo: unknown = null;

  for (const entry of ordered) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(await readEntry(bytes, entry))) as unknown;
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object') continue;
    if (!bundleInfo && 'version' in json && 'public_key' in json) bundleInfo = json;
    if (!patchesList && Array.isArray((json as { patches?: unknown }).patches)) patchesList = json;
    if (patchesList && bundleInfo) break;
  }

  if (!patchesList) throw new Error('That archive does not contain a patches-list.json — is it a Morphe patch bundle?');
  return { patchesList, bundleInfo };
}
