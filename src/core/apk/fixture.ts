import { createHash, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds a small but structurally real APK: a binary (`AXML`) AndroidManifest, a
 * dummy classes.dex, a central directory, and an APK Signing Block carrying a v2
 * signature from PatchPilot's test key.
 *
 * It exists so the verification path can be exercised end to end without
 * shipping anyone's copyrighted app: tests build APKs for arbitrary packages and
 * versions, and the offline demo source serves them. APKs built here are marked
 * as fixtures — their signing certificate is *not* any real app's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', '..', '..', 'fixtures', 'testkey');

export interface BuildApkOptions {
  packageName: string;
  versionName: string;
  versionCode: number;
  minSdk?: number;
  targetSdk?: number;
  label?: string;
  /** Extra bytes to make files look less synthetic; default keeps fixtures tiny. */
  paddingBytes?: number;
  sign?: boolean;
  certificateDer?: Buffer;
  privateKeyPem?: string;
}

/* ------------------------------------------------------------------ AXML ---- */

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_NAMESPACE = 0x0100;
const RES_XML_END_NAMESPACE = 0x0101;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;

const ATTR_IDS: Record<string, number> = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
};

class StringPoolBuilder {
  private readonly strings: string[] = [];
  private readonly index = new Map<string, number>();

  add(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.strings.length;
    this.strings.push(value);
    this.index.set(value, next);
    return next;
  }

  build(): Buffer {
    const encoded = this.strings.map((value) => {
      const bytes = Buffer.from(value, 'utf8');
      const lengths: number[] = [];
      // UTF-8 pools store the UTF-16 length, then the byte length.
      const utf16Length = value.length;
      lengths.push(utf16Length > 0x7f ? 0x80 | (utf16Length >> 8) : utf16Length);
      if (utf16Length > 0x7f) lengths.push(utf16Length & 0xff);
      const byteLength = bytes.length;
      lengths.push(byteLength > 0x7f ? 0x80 | (byteLength >> 8) : byteLength);
      if (byteLength > 0x7f) lengths.push(byteLength & 0xff);
      return Buffer.concat([Buffer.from(lengths), bytes, Buffer.from([0])]);
    });

    const headerSize = 28;
    const offsetsSize = this.strings.length * 4;
    const data = Buffer.concat(encoded);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    const stringsStart = headerSize + offsetsSize;
    const chunkSize = stringsStart + padded.length;

    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(RES_STRING_POOL, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(chunkSize, 4);
    header.writeUInt32LE(this.strings.length, 8);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(0x100, 16); // UTF-8 flag
    header.writeUInt32LE(stringsStart, 20);
    header.writeUInt32LE(0, 24);

    const offsets = Buffer.alloc(offsetsSize);
    let cursor = 0;
    encoded.forEach((buffer, i) => {
      offsets.writeUInt32LE(cursor, i * 4);
      cursor += buffer.length;
    });

    return Buffer.concat([header, offsets, padded]);
  }
}

interface XmlAttribute {
  nameIndex: number;
  resourceId?: number;
  type: number;
  data: number;
}

function elementChunk(elementNameIndex: number, attributes: XmlAttribute[], ending: boolean): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(0xffffffff, 0); // namespace
  body.writeUInt32LE(elementNameIndex, 4);
  body.writeUInt16LE(20, 8); // attribute start
  body.writeUInt16LE(20, 10); // attribute size
  body.writeUInt16LE(ending ? 0 : attributes.length, 12);
  body.writeUInt16LE(0, 14);
  body.writeUInt16LE(0, 16);
  body.writeUInt16LE(0, 18);

  const attributeBytes = Buffer.alloc(attributes.length * 20);
  attributes.forEach((attribute, i) => {
    const at = i * 20;
    attributeBytes.writeUInt32LE(0xffffffff, at); // namespace
    attributeBytes.writeUInt32LE(attribute.nameIndex, at + 4);
    attributeBytes.writeInt32LE(attribute.type === TYPE_STRING ? attribute.data : -1, at + 8);
    attributeBytes.writeUInt16LE(8, at + 12);
    attributeBytes.writeUInt8(0, at + 14);
    attributeBytes.writeUInt8(attribute.type, at + 15);
    attributeBytes.writeUInt32LE(attribute.data, at + 16);
  });

  const headerSize = 16;
  const size = headerSize + body.length + attributeBytes.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(ending ? RES_XML_END_ELEMENT : RES_XML_START_ELEMENT, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(1, 8); // line number
  header.writeUInt32LE(0xffffffff, 12); // comment

  return Buffer.concat([header, body, attributeBytes]);
}

function namespaceChunk(prefixIndex: number, uriIndex: number, ending: boolean): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt16LE(ending ? RES_XML_END_NAMESPACE : RES_XML_START_NAMESPACE, 0);
  header.writeUInt16LE(16, 2);
  header.writeUInt32LE(24, 4);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(0xffffffff, 12);
  const body = Buffer.alloc(8);
  body.writeUInt32LE(prefixIndex, 0);
  body.writeUInt32LE(uriIndex, 4);
  return Buffer.concat([header, body]);
}

/** Encodes a minimal binary AndroidManifest.xml. */
export function buildBinaryManifest(options: BuildApkOptions): Buffer {
  const pool = new StringPoolBuilder();

  // Attribute names come first so their pool indices line up with the resource map.
  const attrNames = ['package', 'versionCode', 'versionName', 'minSdkVersion', 'targetSdkVersion'];
  const attrIndex = new Map<string, number>();
  for (const name of attrNames) attrIndex.set(name, pool.add(name));

  const resourceMap = Buffer.alloc(attrNames.length * 4);
  attrNames.forEach((name, i) => {
    resourceMap.writeUInt32LE(ATTR_IDS[name] ?? 0, i * 4);
  });

  const androidPrefix = pool.add('android');
  const androidUri = pool.add('http://schemas.android.com/apk/res/android');
  const manifestName = pool.add('manifest');
  const usesSdkName = pool.add('uses-sdk');
  const applicationName = pool.add('application');
  const packageValue = pool.add(options.packageName);
  const versionValue = pool.add(options.versionName);

  const stringPool = pool.build();

  const resourceMapChunk = Buffer.alloc(8 + resourceMap.length);
  resourceMapChunk.writeUInt16LE(RES_XML_RESOURCE_MAP, 0);
  resourceMapChunk.writeUInt16LE(8, 2);
  resourceMapChunk.writeUInt32LE(8 + resourceMap.length, 4);
  resourceMap.copy(resourceMapChunk, 8);

  const chunks = [
    namespaceChunk(androidPrefix, androidUri, false),
    elementChunk(manifestName, [
      { nameIndex: attrIndex.get('package')!, type: TYPE_STRING, data: packageValue },
      { nameIndex: attrIndex.get('versionCode')!, type: TYPE_INT_DEC, data: options.versionCode },
      { nameIndex: attrIndex.get('versionName')!, type: TYPE_STRING, data: versionValue },
    ], false),
    elementChunk(usesSdkName, [
      { nameIndex: attrIndex.get('minSdkVersion')!, type: TYPE_INT_DEC, data: options.minSdk ?? 26 },
      { nameIndex: attrIndex.get('targetSdkVersion')!, type: TYPE_INT_DEC, data: options.targetSdk ?? 34 },
    ], false),
    elementChunk(usesSdkName, [], true),
    elementChunk(applicationName, [], false),
    elementChunk(applicationName, [], true),
    elementChunk(manifestName, [], true),
    namespaceChunk(androidPrefix, androidUri, true),
  ];

  const body = Buffer.concat([stringPool, resourceMapChunk, ...chunks]);
  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------- zip ---- */

export interface ZipEntryInput {
  name: string;
  data: Buffer;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildLocalEntry(entry: ZipEntryInput): Buffer {
  const nameBytes = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(0, 10); // time
  header.writeUInt16LE(0, 12); // date
  header.writeUInt32LE(crc32(entry.data), 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, entry.data]);
}

function buildCentralDirectory(entries: ZipEntryInput[], offsets: number[]): Buffer {
  const parts = entries.map((entry, i) => {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc32(entry.data), 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offsets[i] ?? 0, 42);
    return Buffer.concat([header, nameBytes]);
  });
  return Buffer.concat(parts);
}

function buildEocd(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

function lengthPrefixed(...buffers: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const buffer of buffers) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(buffer.length, 0);
    parts.push(length, buffer);
  }
  return Buffer.concat(parts);
}

function sequence(...buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

function buildV2BlockContentDigest(contents: Buffer, central: Buffer, eocd: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (const section of [contents, central, eocd]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(section.length, 0);
    chunks.push(createHash('sha256').update(section).digest(), length);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest();
}

export function loadTestKey(): { certificateDer: Buffer; privateKeyPem: string } {
  return {
    certificateDer: readFileSync(join(fixtureDir, 'cert.der')),
    privateKeyPem: readFileSync(join(fixtureDir, 'key.pem'), 'utf8'),
  };
}

/** Certificate fingerprint the fixture APKs are signed with. */
export function testCertificateSha256(): string {
  return createHash('sha256').update(loadTestKey().certificateDer).digest('hex');
}

/** Builds a plain stored-entry zip, used to assemble .apkm/.xapk style bundles in tests. */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const bytes = buildLocalEntry(entry);
    offsets.push(offset);
    localParts.push(bytes);
    offset += bytes.length;
  }
  const central = buildCentralDirectory(entries, offsets);
  return Buffer.concat([Buffer.concat(localParts), central, buildEocd(entries.length, central.length, offset)]);
}

export function buildApk(options: BuildApkOptions): Buffer {
  const manifest = buildBinaryManifest(options);
  const dex = Buffer.concat([
    Buffer.from('dex\n035\0', 'latin1'),
    Buffer.alloc(Math.max(options.paddingBytes ?? 256, 64), 0),
  ]);

  const entries: ZipEntryInput[] = [
    { name: 'AndroidManifest.xml', data: manifest },
    { name: 'classes.dex', data: dex },
  ];

  const localParts: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const bytes = buildLocalEntry(entry);
    offsets.push(offset);
    localParts.push(bytes);
    offset += bytes.length;
  }
  const localContents = Buffer.concat(localParts);
  const central = buildCentralDirectory(entries, offsets);

  if (options.sign === false) {
    const eocd = buildEocd(entries.length, central.length, offset);
    return Buffer.concat([localContents, central, eocd]);
  }

  const key = loadTestKey();
  const certificate = options.certificateDer ?? key.certificateDer;
  const privateKey = options.privateKeyPem ?? key.privateKeyPem;

  // The signing block shifts the central directory, so its offset is part of the
  // signed data; iterate once to settle it.
  const buildWith = (centralOffset: number): Buffer => {
    const eocd = buildEocd(entries.length, central.length, centralOffset);
    const digest = buildV2BlockContentDigest(localContents, central, eocd);
    const digests = lengthPrefixed(sequence(Buffer.from([0x5a, 0x03, 0x05, 0x01]), Buffer.from(digest)));
    const certificates = lengthPrefixed(certificate);
    const signedData = lengthPrefixed(digests, certificates);
    const signature = cryptoSign('sha256', signedData, privateKey);
    const signatureRecord = lengthPrefixed(sequence(Buffer.from([0x5a, 0x03, 0x05, 0x01]), signature));
    const signatures = lengthPrefixed(signatureRecord);
    const publicKey = Buffer.from('fixture-public-key-placeholder', 'utf8');
    const signer = lengthPrefixed(signedData, signatures, publicKey);
    // The block value holds a sequence of length-prefixed signers.
    const signers = lengthPrefixed(signer);

    const pairValue = sequence(Buffer.alloc(4), signers);
    pairValue.writeUInt32LE(signers.length, 0);
    const pairSize = pairValue.length + 4;
    const pairHeader = Buffer.alloc(12);
    pairHeader.writeBigUInt64LE(BigInt(pairSize), 0);
    pairHeader.writeUInt32LE(0x7109871a, 8);
    const pair = Buffer.concat([pairHeader, pairValue]);

    const blockSize = pair.length + 24; // pairs + trailing size + magic
    const leadingSize = Buffer.alloc(8);
    leadingSize.writeBigUInt64LE(BigInt(blockSize), 0);
    const trailingSize = Buffer.alloc(8);
    trailingSize.writeBigUInt64LE(BigInt(blockSize), 0);
    const magic = Buffer.from('APK Sig Block 42', 'latin1');

    return Buffer.concat([leadingSize, pair, trailingSize, magic]);
  };

  let signingBlock = buildWith(0);
  signingBlock = buildWith(localContents.length + signingBlock.length);
  return Buffer.concat([localContents, signingBlock, central, buildEocd(entries.length, central.length, localContents.length + signingBlock.length)]);
}

/* ------------------------------------------------------------------- CLI ---- */

async function main(): Promise<void> {
  const target = process.argv[2];
  const out = target ?? join(here, '..', '..', '..', 'fixtures', 'apk', 'fixture-demo.apk');
  const bytes = buildApk({
    packageName: 'com.example.patchpilot.fixture',
    versionName: '1.2.3',
    versionCode: 123,
    minSdk: 26,
  });
  writeFileSync(out, bytes);
  console.log(`Wrote ${out} (${bytes.length} bytes)`);
  console.log(`Fixture certificate sha256: ${testCertificateSha256()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
