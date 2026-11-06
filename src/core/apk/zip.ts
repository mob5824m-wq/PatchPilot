import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal random-access zip reader.
 *
 * APKs are zip files, and the parts PatchPilot needs (the binary manifest, the
 * signing block, the small metadata files inside split bundles) live at known
 * offsets. Pulling whole multi-hundred-megabyte archives into memory to look at
 * a 2 KB manifest is wasteful, so this reader walks the central directory and
 * only reads the bytes it is asked for.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_SIGNATURE = 0x06064b50;
const EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

export class ZipReader {
  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
    readonly entries: ZipEntry[],
    readonly comment: string,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      const tailLength = Math.min(stat.size, EOCD_MIN_SIZE + MAX_COMMENT);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, stat.size - tailLength);

      let eocdOffset = -1;
      for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
          eocdOffset = i;
          break;
        }
      }
      if (eocdOffset < 0) throw new ZipError('Not a zip archive: no end-of-central-directory record found');

      const commentLength = tail.readUInt16LE(eocdOffset + 20);
      const comment = tail.subarray(eocdOffset + 22, eocdOffset + 22 + commentLength).toString('utf8');

      let totalEntries = tail.readUInt16LE(eocdOffset + 10);
      let centralSize = tail.readUInt32LE(eocdOffset + 12);
      let centralOffset = tail.readUInt32LE(eocdOffset + 16);

      // Zip64: the locator sits 20 bytes before the classic record.
      if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        const locatorOffset = eocdOffset - 20;
        if (locatorOffset >= 0 && tail.readUInt32LE(locatorOffset) === EOCD_LOCATOR_SIGNATURE) {
          const eocd64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8));
          const record = Buffer.alloc(56);
          if (eocd64Offset + record.length <= stat.size) {
            await handle.read(record, 0, record.length, eocd64Offset);
            if (record.readUInt32LE(0) === EOCD64_SIGNATURE) {
              totalEntries = Number(record.readBigUInt64LE(32));
              centralSize = Number(record.readBigUInt64LE(40));
              centralOffset = Number(record.readBigUInt64LE(48));
            }
          }
        }
      }

      if (centralOffset + centralSize > stat.size) {
        throw new ZipError('Corrupt zip: central directory points past the end of the file');
      }

      const central = Buffer.alloc(centralSize);
      await handle.read(central, 0, centralSize, centralOffset);

      const entries: ZipEntry[] = [];
      let cursor = 0;
      while (cursor + 46 <= central.length && central.readUInt32LE(cursor) === CENTRAL_SIGNATURE) {
        const flags = central.readUInt16LE(cursor + 8);
        const method = central.readUInt16LE(cursor + 10);
        const crc32 = central.readUInt32LE(cursor + 16);
        let compressedSize = central.readUInt32LE(cursor + 20);
        let size = central.readUInt32LE(cursor + 24);
        const nameLength = central.readUInt16LE(cursor + 28);
        const extraLength = central.readUInt16LE(cursor + 30);
        const entryCommentLength = central.readUInt16LE(cursor + 32);
        let localHeaderOffset = central.readUInt32LE(cursor + 42);
        const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString(
          (flags & 0x800) !== 0 ? 'utf8' : 'latin1',
        );

        if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
          const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
          let offset = 0;
          while (offset + 4 <= extra.length) {
            const id = extra.readUInt16LE(offset);
            const length = extra.readUInt16LE(offset + 2);
            if (id === 0x0001) {
              let field = offset + 4;
              const end = Math.min(field + length, extra.length);
              if (size === 0xffffffff && field + 8 <= end) {
                size = Number(extra.readBigUInt64LE(field));
                field += 8;
              }
              if (compressedSize === 0xffffffff && field + 8 <= end) {
                compressedSize = Number(extra.readBigUInt64LE(field));
                field += 8;
              }
              if (localHeaderOffset === 0xffffffff && field + 8 <= end) {
                localHeaderOffset = Number(extra.readBigUInt64LE(field));
              }
              break;
            }
            offset += 4 + length;
          }
        }

        entries.push({
          name,
          method,
          compressedSize,
          size,
          crc32,
          localHeaderOffset,
          isDirectory: name.endsWith('/'),
        });
        cursor += 46 + nameLength + extraLength + entryCommentLength;
      }

      return new ZipReader(handle, stat.size, entries, comment);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }

  findBySuffix(suffix: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name.endsWith(suffix));
  }

  /** Entries whose name matches, ignoring directories. */
  select(predicate: (entry: ZipEntry) => boolean): ZipEntry[] {
    return this.entries.filter((entry) => !entry.isDirectory && predicate(entry));
  }

  async read(entry: ZipEntry | string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const target = typeof entry === 'string' ? this.find(entry) : entry;
    if (!target) throw new ZipError(`Entry not found in archive: ${String(entry)}`);
    if (target.size > maxBytes) {
      throw new ZipError(`Entry ${target.name} is ${target.size} bytes, over the ${maxBytes} byte read limit`);
    }

    const header = Buffer.alloc(30);
    await this.handle.read(header, 0, 30, target.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError(`Corrupt zip: bad local header for ${target.name}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataStart = target.localHeaderOffset + 30 + nameLength + extraLength;

    if (target.compressedSize === 0) return Buffer.alloc(0);

    const raw = Buffer.alloc(target.compressedSize);
    await this.handle.read(raw, 0, target.compressedSize, dataStart);

    if (target.method === 0) return raw;
    if (target.method === 8) return inflateRawSync(raw);
    throw new ZipError(`Unsupported compression method ${target.method} for ${target.name}`);
  }

  async readText(entry: ZipEntry | string, maxBytes?: number): Promise<string> {
    return (await this.read(entry, maxBytes)).toString('utf8');
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

/** Peek at the signature without keeping a handle open. */
export async function isZipFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead < 4) return false;
    const signature = head.readUInt32LE(0);
    return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE;
  } finally {
    await handle.close();
  }
}
