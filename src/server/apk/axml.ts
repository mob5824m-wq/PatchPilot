/**
 * Parser for Android's binary XML (`AndroidManifest.xml` inside an APK).
 *
 * Only what PatchPilot needs is decoded: the manifest's `package`, `versionCode`
 * and `versionName`, plus the `uses-sdk` bounds and split flags. Everything is
 * read defensively — a manifest written slightly differently by some build
 * system should degrade into a warning instead of a crash.
 */

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;

const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

/** Framework attribute resource ids, used when the string pool omits the names. */
export const ANDROID_ATTRIBUTES = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  compileSdkVersion: 0x01010572,
  label: 0x01010001,
  name: 0x01010003,
  isSplitRequired: 0x01010591,
} as const;

export interface ManifestInfo {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  targetSdk: number | null;
  compileSdk: number | null;
  label: string | null;
  isSplitRequired: boolean;
  /** True when the document was plain-text XML rather than Android's binary form. */
  plainText: boolean;
  warnings: string[];
}

export class AxmlError extends Error {}

interface StringPool {
  strings: string[];
}

interface Attribute {
  name: string | null;
  resourceId: number | null;
  /** Value as text, resolved through the string pool when the type is a string. */
  value: string | null;
  intValue: number | null;
  dataType: number;
}

function emptyInfo(): ManifestInfo {
  return {
    packageName: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    targetSdk: null,
    compileSdk: null,
    label: null,
    isSplitRequired: false,
    plainText: false,
    warnings: [],
  };
}

function readStringPool(buffer: Buffer, offset: number, chunkSize: number): StringPool {
  const stringCount = buffer.readUInt32LE(offset + 8);
  const flags = buffer.readUInt32LE(offset + 16);
  const stringsStart = buffer.readUInt32LE(offset + 20);
  const isUtf8 = (flags & 0x100) !== 0;

  const offsetsStart = offset + 28;
  const dataStart = offset + stringsStart;
  const dataEnd = Math.min(offset + chunkSize, buffer.length);
  const strings: string[] = [];

  for (let i = 0; i < stringCount; i++) {
    if (offsetsStart + i * 4 + 4 > dataEnd) break;
    const stringOffset = buffer.readUInt32LE(offsetsStart + i * 4);
    const at = dataStart + stringOffset;
    if (at <= dataStart - 1 || at >= dataEnd) {
      strings.push('');
      continue;
    }
    try {
      strings.push(isUtf8 ? readUtf8String(buffer, at, dataEnd) : readUtf16String(buffer, at, dataEnd));
    } catch {
      strings.push('');
    }
  }

  return { strings };
}

function readUtf8String(buffer: Buffer, at: number, end: number): string {
  let cursor = at;
  const readLength = (): number => {
    let value = buffer[cursor++];
    if (value === undefined) throw new AxmlError('truncated string pool');
    if ((value & 0x80) !== 0) value = ((value & 0x7f) << 8) | buffer[cursor++];
    return value;
  };
  readLength(); // UTF-16 length, unused
  const byteLength = readLength();
  const stop = Math.min(cursor + byteLength, end);
  return buffer.subarray(cursor, stop).toString('utf8');
}

function readUtf16String(buffer: Buffer, at: number, end: number): string {
  let cursor = at;
  let length = buffer.readUInt16LE(cursor);
  cursor += 2;
  if ((length & 0x8000) !== 0) {
    length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(cursor);
    cursor += 2;
  }
  const stop = Math.min(cursor + length * 2, end);
  return buffer.subarray(cursor, stop).toString('utf16le');
}

export function parseBinaryManifest(buffer: Buffer): ManifestInfo {
  const info = emptyInfo();
  if (buffer.length < 8) throw new AxmlError('Manifest is too small to be binary XML');

  const fileType = buffer.readUInt16LE(0);
  const headerSize = buffer.readUInt16LE(2);
  if (fileType !== RES_XML) {
    const text = buffer.toString('utf8');
    if (text.includes('<manifest')) return parseTextManifest(text, info);
    throw new AxmlError('AndroidManifest.xml is not binary XML');
  }

  let pool: StringPool = { strings: [] };
  let resourceMap: number[] = [];

  let cursor = headerSize;
  while (cursor + 8 <= buffer.length) {
    const chunkType = buffer.readUInt16LE(cursor);
    const chunkHeaderSize = buffer.readUInt16LE(cursor + 2);
    const chunkSize = buffer.readUInt32LE(cursor + 4);
    if (chunkSize < 8 || cursor + chunkSize > buffer.length) {
      info.warnings.push(
        `Stopped reading the manifest at offset ${cursor}: chunk size ${chunkSize} overruns the file`,
      );
      break;
    }

    if (chunkType === RES_STRING_POOL) {
      pool = readStringPool(buffer, cursor, chunkSize);
    } else if (chunkType === RES_XML_RESOURCE_MAP) {
      const count = Math.floor((chunkSize - chunkHeaderSize) / 4);
      resourceMap = [];
      for (let i = 0; i < count; i++) {
        resourceMap.push(buffer.readUInt32LE(cursor + chunkHeaderSize + i * 4));
      }
    } else if (chunkType === RES_XML_START_ELEMENT) {
      const element = readStartElement(buffer, cursor, chunkHeaderSize, pool, resourceMap, info.warnings);
      if (element) applyElement(element.name, element.attributes, info);
    }

    cursor += chunkSize;
  }

  return info;
}

function readStartElement(
  buffer: Buffer,
  chunkOffset: number,
  chunkHeaderSize: number,
  pool: StringPool,
  resourceMap: number[],
  warnings: string[],
): { name: string | null; attributes: Attribute[] } | null {
  const body = chunkOffset + chunkHeaderSize;
  if (body + 20 > buffer.length) return null;

  const nameIndex = buffer.readUInt32LE(body + 4);
  const attributeStart = buffer.readUInt16LE(body + 8);
  const attributeSize = buffer.readUInt16LE(body + 10);
  const attributeCount = buffer.readUInt16LE(body + 12);
  const name = pool.strings[nameIndex] ?? null;

  const attributes: Attribute[] = [];
  const step = attributeSize >= 12 ? attributeSize : 20;

  for (let i = 0; i < attributeCount; i++) {
    const at = body + attributeStart + i * step;
    if (at + 20 > buffer.length) {
      warnings.push('Attribute list runs past the end of the manifest');
      break;
    }
    const attrNameIndex = buffer.readUInt32LE(at + 4);
    const rawValue = buffer.readInt32LE(at + 8);
    const dataType = buffer[at + 15];
    const data = buffer.readUInt32LE(at + 16);
    const resourceId = attrNameIndex < resourceMap.length ? (resourceMap[attrNameIndex] ?? null) : null;

    let value: string | null = null;
    if (dataType === TYPE_STRING) {
      value = pool.strings[data] ?? null;
    } else if (rawValue >= 0) {
      value = pool.strings[rawValue] ?? null;
    }
    if (value === null && (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX)) {
      value = String(data);
    }
    if (value === null && dataType === TYPE_INT_BOOLEAN) {
      value = data !== 0 ? 'true' : 'false';
    }
    if (value === null && dataType === TYPE_REFERENCE) {
      value = `@0x${(data >>> 0).toString(16)}`;
    }
    if (value === null && dataType === TYPE_NULL) {
      value = null;
    }

    attributes.push({
      name: pool.strings[attrNameIndex] || null,
      resourceId,
      value,
      intValue: dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX ? data : null,
      dataType,
    });
  }

  return { name, attributes };
}

function attrName(attribute: Attribute): string | null {
  if (attribute.name) return attribute.name;
  if (attribute.resourceId == null) return null;
  const known = Object.entries(ANDROID_ATTRIBUTES).find(([, id]) => id === attribute.resourceId);
  return known ? known[0] : null;
}

function applyElement(name: string | null, attributes: Attribute[], info: ManifestInfo): void {
  if (!name) return;
  for (const attribute of attributes) {
    const key = attrName(attribute);
    if (!key) continue;
    if (name === 'manifest') {
      if (key === 'package') info.packageName = attribute.value;
      else if (key === 'versionName') info.versionName = attribute.value;
      else if (key === 'versionCode') info.versionCode = attribute.intValue ?? numberOrNull(attribute.value);
      else if (key === 'compileSdkVersion') info.compileSdk = attribute.intValue ?? numberOrNull(attribute.value);
    } else if (name === 'uses-sdk') {
      if (key === 'minSdkVersion') info.minSdk = attribute.intValue ?? numberOrNull(attribute.value);
      else if (key === 'targetSdkVersion') info.targetSdk = attribute.intValue ?? numberOrNull(attribute.value);
    } else if (name === 'application') {
      if (key === 'isSplitRequired') {
        info.isSplitRequired = (attribute.intValue ?? 0) !== 0 || attribute.value === 'true';
      } else if (key === 'label' && !info.label) {
        const label = attribute.value;
        if (label && !label.startsWith('@')) info.label = label;
      }
    }
  }
}

export function parseTextManifest(text: string, target?: ManifestInfo): ManifestInfo {
  const info = target ?? emptyInfo();
  info.plainText = true;

  const manifestTag = /<manifest\b[^>]*>/i.exec(text);
  if (manifestTag) {
    info.packageName = attributeOf(manifestTag[0], 'package') ?? info.packageName;
    info.versionName = attributeOf(manifestTag[0], 'versionName') ?? info.versionName;
    const code = attributeOf(manifestTag[0], 'versionCode');
    if (code) info.versionCode = numberOrNull(code);
    const compileSdk = attributeOf(manifestTag[0], 'compileSdkVersion');
    if (compileSdk) info.compileSdk = numberOrNull(compileSdk);
  }
  const usesSdk = /<uses-sdk\b[^>]*>/i.exec(text);
  if (usesSdk) {
    const min = attributeOf(usesSdk[0], 'minSdkVersion');
    if (min) info.minSdk = numberOrNull(min);
    const target = attributeOf(usesSdk[0], 'targetSdkVersion');
    if (target) info.targetSdk = numberOrNull(target);
  }
  return info;
}

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match ? match[1] : null;
}

export function numberOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed, 16);
  return null;
}
