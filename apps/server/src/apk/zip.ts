import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { AppError } from '../errors.js';

/**
 * Hardened ZIP reading for untrusted APKs and a minimal raw ZIP writer used
 * to repackage an APK while replacing a single entry.
 */

export const MAX_ENTRIES = 200_000;

export async function openZip(path: string): Promise<ZipFile> {
  try {
    return await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
  } catch (error) {
    throw new AppError(422, 'INVALID_APK', `Not a valid APK/ZIP file: ${(error as Error).message}`);
  }
}

export function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      if (entries.length >= MAX_ENTRIES) {
        reject(new AppError(422, 'INVALID_APK', 'APK has too many entries'));
        return;
      }
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        reject(new AppError(422, 'INVALID_APK', 'Encrypted ZIP entries are not supported'));
        return;
      }
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', (error: Error) => reject(new AppError(422, 'INVALID_APK', `Corrupt APK: ${error.message}`)));
    zip.readEntry();
  });
}

/** Reads a (decompressed) entry fully, refusing anything larger than `maxBytes`. */
export async function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) {
    throw new AppError(422, 'ENTRY_TOO_LARGE', `${entry.fileName} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new AppError(422, 'ENTRY_TOO_LARGE', `${entry.fileName} exceeds its declared size`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** First `bytes` bytes of an entry's decompressed content. */
export async function readEntryHead(zip: ZipFile, entry: Entry, bytes: number): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= bytes) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, bytes);
}

/* ------------------------------------------------------------------------ */
/* Raw writer                                                               */
/* ------------------------------------------------------------------------ */

interface CentralRecord {
  name: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  versionNeeded: number;
  internalAttrs: number;
  externalAttrs: number;
  offset: number;
}

/**
 * Writes a ZIP by copying entries' compressed bytes verbatim (no recompression)
 * and accepting replacement content for selected entries. Local headers carry
 * sizes and CRC directly (no data descriptors), which is what Android's
 * libziparchive and zipalign expect. ZIP64 is not supported (APKs < 4 GB).
 */
export class RawZipWriter {
  private readonly out: WriteStream;
  private offset = 0;
  private readonly records: CentralRecord[] = [];

  constructor(path: string) {
    this.out = createWriteStream(path, { mode: 0o600 });
  }

  private async write(buffer: Buffer): Promise<void> {
    this.offset += buffer.length;
    if (this.offset > 0xffffffff) throw new AppError(422, 'APK_TOO_LARGE', 'Output exceeds 4 GB');
    if (!this.out.write(buffer)) await once(this.out, 'drain');
  }

  private localHeader(r: Omit<CentralRecord, 'offset'>): Buffer {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(r.versionNeeded, 4);
    header.writeUInt16LE(r.flags, 6);
    header.writeUInt16LE(r.method, 8);
    header.writeUInt16LE(r.time, 10);
    header.writeUInt16LE(r.date, 12);
    header.writeUInt32LE(r.crc >>> 0, 14);
    header.writeUInt32LE(r.compressedSize, 18);
    header.writeUInt32LE(r.uncompressedSize, 22);
    header.writeUInt16LE(r.name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, r.name]);
  }

  private base(entry: Entry): Omit<CentralRecord, 'offset' | 'method' | 'crc' | 'compressedSize' | 'uncompressedSize'> {
    const name = Buffer.from(entry.fileName, 'utf8');
    const nonAscii = name.some((b) => b > 0x7f);
    // Clear bit 3 (data descriptor); set bit 11 for UTF-8 names.
    const flags = (entry.generalPurposeBitFlag & ~0x0008 & ~0x0800) | (nonAscii ? 0x0800 : 0);
    return {
      name,
      flags,
      time: entry.lastModFileTime,
      date: entry.lastModFileDate,
      versionMadeBy: entry.versionMadeBy,
      versionNeeded: Math.max(entry.versionNeededToExtract, 20),
      internalAttrs: entry.internalFileAttributes,
      externalAttrs: entry.externalFileAttributes,
    };
  }

  /** Copies an entry from `zip` without decompressing it. */
  async copyRaw(zip: ZipFile, entry: Entry): Promise<void> {
    const record: CentralRecord = {
      ...this.base(entry),
      method: entry.compressionMethod,
      crc: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      offset: this.offset,
    };
    await this.write(this.localHeader(record));
    const stream: Readable = await zip.openReadStreamPromise(entry, { decodeFileData: false });
    let copied = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      copied += chunk.length;
      await this.write(chunk);
    }
    if (copied !== entry.compressedSize) throw new AppError(422, 'INVALID_APK', `Truncated entry ${entry.fileName}`);
    this.records.push(record);
  }

  /** Writes `content` in place of `entry`, deflated unless the original was stored. */
  async replace(entry: Entry, content: Buffer): Promise<void> {
    const stored = entry.compressionMethod === 0;
    const data = stored ? content : deflateRawSync(content, { level: 9 });
    const record: CentralRecord = {
      ...this.base(entry),
      method: stored ? 0 : 8,
      crc: crc32(content),
      compressedSize: data.length,
      uncompressedSize: content.length,
      offset: this.offset,
    };
    await this.write(this.localHeader(record));
    await this.write(data);
    this.records.push(record);
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const r of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(r.versionMadeBy, 4);
      header.writeUInt16LE(r.versionNeeded, 6);
      header.writeUInt16LE(r.flags, 8);
      header.writeUInt16LE(r.method, 10);
      header.writeUInt16LE(r.time, 12);
      header.writeUInt16LE(r.date, 14);
      header.writeUInt32LE(r.crc >>> 0, 16);
      header.writeUInt32LE(r.compressedSize, 20);
      header.writeUInt32LE(r.uncompressedSize, 24);
      header.writeUInt16LE(r.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(r.internalAttrs, 36);
      header.writeUInt32LE(r.externalAttrs >>> 0, 38);
      header.writeUInt32LE(r.offset, 42);
      await this.write(Buffer.concat([header, r.name]));
    }
    const size = this.offset - start;
    if (this.records.length > 0xffff) throw new AppError(422, 'APK_TOO_LARGE', 'Too many entries for a non-ZIP64 archive');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.out.end();
    await once(this.out, 'finish');
  }

  abort(): void {
    this.out.destroy();
  }
}

/** v1 (JAR) signature files that must be dropped when re-signing. */
export function isSignatureEntry(name: string): boolean {
  if (!name.startsWith('META-INF/')) return false;
  const base = name.slice('META-INF/'.length);
  if (base.includes('/')) return false;
  return base === 'MANIFEST.MF' || /\.(SF|RSA|DSA|EC)$/i.test(base);
}
