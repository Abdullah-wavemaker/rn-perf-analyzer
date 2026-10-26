/**
 * Parser for Android binary XML (compiled AndroidManifest.xml).
 *
 * Input is untrusted: every offset is bounds-checked, chunk sizes must make
 * progress, and the element count is capped. Attribute names fall back to
 * the resource-ID map because obfuscated APKs often blank the string names.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string | number | boolean>;
  children: XmlElement[];
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 0x100;
const MAX_ELEMENTS = 100_000;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

/** Well-known android: attribute resource IDs. */
const ATTR_IDS: Record<number, string> = {
  0x01010003: 'name',
  0x01010001: 'label',
  0x0101000f: 'debuggable',
  0x01010010: 'exported',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x01010202: 'targetActivity',
  0x010104ea: 'extractNativeLibs',
  0x01010527: 'networkSecurityConfig',
  0x01010000: 'theme',
};

class Reader {
  constructor(readonly buf: Buffer) {}
  u16(at: number): number {
    if (at < 0 || at + 2 > this.buf.length) throw new Error('AXML: read out of bounds');
    return this.buf.readUInt16LE(at);
  }
  u32(at: number): number {
    if (at < 0 || at + 4 > this.buf.length) throw new Error('AXML: read out of bounds');
    return this.buf.readUInt32LE(at);
  }
  u8(at: number): number {
    if (at < 0 || at + 1 > this.buf.length) throw new Error('AXML: read out of bounds');
    return this.buf.readUInt8(at);
  }
}

function readStringPool(r: Reader, start: number): string[] {
  const headerSize = r.u16(start + 2);
  const count = r.u32(start + 8);
  const flags = r.u32(start + 16);
  const stringsStart = r.u32(start + 20);
  if (count > 1_000_000) throw new Error('AXML: string pool too large');
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let at = start + stringsStart + r.u32(start + headerSize + i * 4);
    if (utf8) {
      // char length (skip), then byte length; each is 1 or 2 bytes.
      at += (r.u8(at) & 0x80) !== 0 ? 2 : 1;
      let len = r.u8(at);
      if ((len & 0x80) !== 0) {
        len = ((len & 0x7f) << 8) | r.u8(at + 1);
        at += 2;
      } else at += 1;
      if (at + len > r.buf.length) throw new Error('AXML: string out of bounds');
      strings[i] = r.buf.toString('utf8', at, at + len);
    } else {
      let len = r.u16(at);
      if ((len & 0x8000) !== 0) {
        len = ((len & 0x7fff) << 16) | r.u16(at + 2);
        at += 4;
      } else at += 2;
      if (at + len * 2 > r.buf.length) throw new Error('AXML: string out of bounds');
      strings[i] = r.buf.toString('utf16le', at, at + len * 2);
    }
  }
  return strings;
}

export function parseAxml(buf: Buffer): XmlElement {
  const r = new Reader(buf);
  if (r.u16(0) !== RES_XML_TYPE) throw new Error('AXML: not a binary XML document');
  const fileSize = Math.min(r.u32(4), buf.length);
  let at = r.u16(2);

  let strings: string[] = [];
  let resourceIds: number[] = [];
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let elements = 0;

  const str = (index: number): string => (index === 0xffffffff ? '' : (strings[index] ?? ''));

  while (at + 8 <= fileSize) {
    const type = r.u16(at);
    const headerSize = r.u16(at + 2);
    const size = r.u32(at + 4);
    if (size < 8 || at + size > fileSize) throw new Error('AXML: invalid chunk size');

    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(r, at);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const n = (size - headerSize) / 4;
      resourceIds = [];
      for (let i = 0; i < n; i++) resourceIds.push(r.u32(at + headerSize + i * 4));
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (++elements > MAX_ELEMENTS) throw new Error('AXML: too many elements');
      const ext = at + headerSize;
      const name = str(r.u32(ext + 4));
      const attrStart = r.u16(ext + 8);
      const attrSize = r.u16(ext + 10);
      const attrCount = r.u16(ext + 12);
      const element: XmlElement = { name, attrs: {}, children: [] };
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIndex = r.u32(a + 4);
        let attrName = str(nameIndex);
        const resId = resourceIds[nameIndex];
        if (resId !== undefined && ATTR_IDS[resId]) attrName = ATTR_IDS[resId] as string;
        if (!attrName) continue;
        const raw = r.u32(a + 8);
        const dataType = r.u8(a + 15);
        const data = r.u32(a + 16);
        let value: string | number | boolean;
        if (raw !== 0xffffffff) value = str(raw);
        else if (dataType === TYPE_STRING) value = str(data);
        else if (dataType === TYPE_INT_BOOLEAN) value = data !== 0;
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else if (dataType === TYPE_REFERENCE) value = `@0x${data.toString(16)}`;
        else value = data;
        element.attrs[attrName] = value;
      }
      (stack[stack.length - 1] as XmlElement).children.push(element);
      stack.push(element);
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      if (stack.length > 1) stack.pop();
    }
    at += size;
  }
  return root;
}

export function* walk(element: XmlElement): Generator<XmlElement> {
  const stack = [element];
  while (stack.length > 0) {
    const el = stack.pop() as XmlElement;
    yield el;
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i] as XmlElement);
  }
}

export interface ManifestInfo {
  packageName: string;
  versionCode: number | null;
  versionName: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  launchActivity: string | null;
}

export function readManifest(buf: Buffer): ManifestInfo {
  const doc = parseAxml(buf);
  const manifest = doc.children.find((c) => c.name === 'manifest');
  if (!manifest) throw new Error('AXML: <manifest> element missing');
  const packageName = String(manifest.attrs.package ?? '');
  const usesSdk = manifest.children.find((c) => c.name === 'uses-sdk');
  const application = manifest.children.find((c) => c.name === 'application');
  const toInt = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

  const qualify = (name: string) => (name.startsWith('.') ? packageName + name : name.includes('.') ? name : `${packageName}.${name}`);
  let launchActivity: string | null = null;
  for (const el of application ? walk(application) : []) {
    if (el.name !== 'activity' && el.name !== 'activity-alias') continue;
    const isLauncher = el.children.some(
      (f) =>
        f.name === 'intent-filter' &&
        f.children.some((c) => c.name === 'action' && c.attrs.name === 'android.intent.action.MAIN') &&
        f.children.some((c) => c.name === 'category' && c.attrs.name === 'android.intent.category.LAUNCHER'),
    );
    if (isLauncher && typeof el.attrs.name === 'string') {
      launchActivity = `${packageName}/${qualify(el.attrs.name)}`;
      break;
    }
  }

  return {
    packageName,
    versionCode: toInt(manifest.attrs.versionCode),
    versionName: typeof manifest.attrs.versionName === 'string' ? manifest.attrs.versionName : null,
    minSdk: toInt(usesSdk?.attrs.minSdkVersion),
    targetSdk: toInt(usesSdk?.attrs.targetSdkVersion),
    debuggable: application?.attrs.debuggable === true,
    launchActivity,
  };
}
