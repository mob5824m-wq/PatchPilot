import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/**
 * Reads the APK Signing Block written by Android's v2/v3 signing schemes and
 * returns SHA-256 fingerprints of the signing certificates.
 *
 * Those fingerprints are exactly what a Morphe patch bundle lists under
 * `signatures` for a package, which lets PatchPilot prove that a downloaded APK
 * is genuinely the app the patches were built for and not a repack.
 */

const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

export interface SigningCertificates {
  /** SHA-256 of each certificate in the v2 block, lowercase hex. */
  v2: string[];
  /** SHA-256 of each certificate in the v3 block, lowercase hex. */
  v3: string[];
  /** True when the archive carries v1 (JAR) signature files. */
  hasV1: boolean;
  warnings: string[];
}

/** Reads a little-endian uint32 length prefix used throughout the signing block. */
function readLength(buffer: Buffer, offset: number): { value: number; next: number } {
  if (offset + 4 > buffer.length) throw new Error('truncated signing block');
  return { value: buffer.readUInt32LE(offset), next: offset + 4 };
}

/** Splits `buffer` into length-prefixed slices. */
function splitLengthPrefixed(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor + 4 <= buffer.length) {
    const { value: length, next } = readLength(buffer, cursor);
    if (length === 0) {
      cursor = next;
      continue;
    }
    if (next + length > buffer.length) break;
    parts.push(buffer.subarray(next, next + length));
    cursor = next + length;
  }
  return parts;
}

/**
 * The v2/v3 block value is a length-prefixed sequence of length-prefixed
 * signers. Some producers omit the outer sequence prefix, so accept both.
 */
function signerBlocks(value: Buffer): Buffer[] {
  const sequence = splitLengthPrefixed(value);
  const wrapped = sequence.length === 1 && (sequence[0]?.length ?? 0) + 4 === value.length;
  return splitLengthPrefixed(wrapped ? (sequence[0] as Buffer) : value);
}

/**
 * A signer is: signed data, signatures, public key — each length prefixed.
 * The signed data holds digests, then the certificate chain.
 */
function certificatesFromV2Signer(signer: Buffer): Buffer[] {
  const [signedData] = splitLengthPrefixed(signer);
  if (!signedData) return [];
  const signedParts = splitLengthPrefixed(signedData);
  const certificates = signedParts[1];
  if (!certificates) return [];
  return splitLengthPrefixed(certificates);
}

/** v3 adds min/max SDK to the signed data, pushing the certificates to index 2. */
function certificatesFromV3Signer(signer: Buffer): Buffer[] {
  const signedData = splitLengthPrefixed(signer)[0];
  if (!signedData) return [];
  const signedParts = splitLengthPrefixed(signedData);
  const certificates = signedParts[2] ?? signedParts[1];
  if (!certificates) return [];
  return splitLengthPrefixed(certificates);
}

function digest(certificate: Buffer): string {
  return createHash('sha256').update(certificate).digest('hex');
}

export function parseSigningBlockPairs(block: Buffer): SigningCertificates {
  const result: SigningCertificates = { v2: [], v3: [], hasV1: false, warnings: [] };

  let cursor = 8; // skip the leading uint64 size
  const end = block.length - 24; // trailing size + magic

  while (cursor + 12 <= end) {
    const id = block.readUInt32LE(cursor + 8);
    const length = Number(block.readBigUInt64LE(cursor));
    const valueStart = cursor + 12;
    if (length < 4 || valueStart + (length - 4) > end) {
      result.warnings.push(`Signing block entry ${id.toString(16)} has an invalid length`);
      break;
    }
    const value = block.subarray(valueStart, valueStart + (length - 4));

    if (id === V2_BLOCK_ID) {
      for (const signer of signerBlocks(value)) {
        for (const certificate of certificatesFromV2Signer(signer)) {
          result.v2.push(digest(certificate));
        }
      }
    } else if (id === V3_BLOCK_ID) {
      for (const signer of signerBlocks(value)) {
        for (const certificate of certificatesFromV3Signer(signer)) {
          result.v3.push(digest(certificate));
        }
      }
    }

    cursor = valueStart + (length - 4);
  }

  return result;
}

/** Locates the APK Signing Block, which sits immediately before the central directory. */
export async function readSigningCertificates(path: string): Promise<SigningCertificates | null> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < EOCD_MIN_SIZE + 32) return null;

    const tailLength = Math.min(stat.size, EOCD_MIN_SIZE + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);

    let eocd = -1;
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const centralDirectoryOffset = tail.readUInt32LE(eocd + 16);
    if (centralDirectoryOffset < 32) return null;

    const footer = Buffer.alloc(24);
    if (centralDirectoryOffset - 24 < 0) return null;
    await handle.read(footer, 0, 24, centralDirectoryOffset - 24);

    const magic = footer.subarray(8, 24).toString('latin1');
    if (magic !== APK_SIG_BLOCK_MAGIC) return null;

    const blockSize = Number(footer.readBigUInt64LE(0));
    const blockStart = centralDirectoryOffset - blockSize - 8;
    if (blockStart < 0 || blockSize < 24 || blockSize > stat.size) return null;

    const block = Buffer.alloc(blockSize + 8);
    await handle.read(block, 0, block.length, blockStart);
    return parseSigningBlockPairs(block);
  } finally {
    await handle.close();
  }
}
