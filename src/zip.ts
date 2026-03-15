import { Transform, Readable } from 'node:stream';
import { createDeflateRaw } from 'node:zlib';
import { crc32 } from './crc32.js';

// ZIP signature constants
const SIG_LOCAL_FILE = 0x04034b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_END_CENTRAL_DIR = 0x06054b50;
const SIG_ZIP64_END_CENTRAL_DIR = 0x06064b50;
const SIG_ZIP64_END_CENTRAL_DIR_LOCATOR = 0x07064b50;

// Compression methods
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// ZIP64 thresholds
const ZIP64_LIMIT = 0xffffffff;
const ZIP64_COUNT_LIMIT = 0xffff;

// Version constants
const VERSION_NEEDED_DEFLATE = 20;
const VERSION_NEEDED_ZIP64 = 45;
const VERSION_MADE_BY = 0x0314; // Unix + ZIP spec 2.0

export interface ZipEntryOptions {
  name: string;
  date?: Date;
  mode?: number;
  store?: boolean;
  comment?: string;
  isDirectory?: boolean;
}

export class ZipArchiveEntry {
  name: string;
  size = 0;
  compressedSize = 0;
  crc = 0;
  method: number;
  date: Date;
  mode: number;
  comment: string;
  isDirectory: boolean;
  offset = 0;
  useZip64 = false;

  constructor(opts: ZipEntryOptions) {
    this.name = opts.name;
    this.date = opts.date ?? new Date();
    this.mode = opts.mode ?? (opts.isDirectory ? 0o40755 : 0o100644);
    this.method = opts.store || opts.isDirectory ? METHOD_STORE : METHOD_DEFLATE;
    this.comment = opts.comment ?? '';
    this.isDirectory = opts.isDirectory ?? false;
  }
}

interface CentralDirRecord {
  entry: ZipArchiveEntry;
  nameBytes: Buffer;
}

export interface ZipOutputStreamOptions {
  zlib?: { level?: number };
  store?: boolean;
  comment?: string;
  forceLocalTime?: boolean;
  forceZip64?: boolean;
  namePrependSlash?: boolean;
}

export class ZipArchiveOutputStream extends Transform {
  private _entries: CentralDirRecord[] = [];
  private _offset = 0;
  private _options: ZipOutputStreamOptions;
  private _processing = false;
  private _queue: Array<{ entry: ZipArchiveEntry; source: Readable | Buffer | null }> = [];
  private _finalized = false;
  private _finalizeResolve: (() => void) | null = null;
  private _finalizeReject: ((err: Error) => void) | null = null;

  constructor(options: ZipOutputStreamOptions = {}) {
    super();
    this._options = options;
    this.on('error', (err) => {
      if (this._finalizeReject) {
        this._finalizeReject(err);
        this._finalizeReject = null;
        this._finalizeResolve = null;
      }
    });
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    callback(null, chunk);
  }

  entry(entry: ZipArchiveEntry, source: Readable | Buffer | string | null): void {
    let src: Readable | Buffer | null;
    if (typeof source === 'string') {
      src = Buffer.from(source);
    } else {
      src = source;
    }
    this._queue.push({ entry, source: src });
    this._processNext();
  }

  private _processNext(): void {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const item = this._queue.shift()!;
    this._writeEntry(item.entry, item.source)
      .then(() => {
        this._processing = false;
        if (this._queue.length > 0) {
          this._processNext();
        } else if (this._finalized) {
          this._writeCentralDirectory();
        }
      })
      .catch((err) => {
        this.destroy(err as Error);
      });
  }

  private async _writeEntry(entry: ZipArchiveEntry, source: Readable | Buffer | null): Promise<void> {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    entry.offset = this._offset;

    // For directories or null source, write stored empty entry
    if (entry.isDirectory || source === null) {
      entry.size = 0;
      entry.compressedSize = 0;
      entry.crc = 0;
      entry.method = METHOD_STORE;

      const header = this._buildLocalFileHeader(entry, nameBytes, false);
      this._pushData(header);
      this._entries.push({ entry, nameBytes });
      return;
    }

    // Use data descriptor approach (bit 3) since we stream
    const useDataDescriptor = true;
    const header = this._buildLocalFileHeader(entry, nameBytes, useDataDescriptor);
    this._pushData(header);

    // Compress/store and accumulate CRC + sizes
    const { crc: entryCrc, size, compressedSize } = await this._writeData(entry, source);

    entry.crc = entryCrc;
    entry.size = size;
    entry.compressedSize = compressedSize;

    // Check if ZIP64 needed
    if (entry.size > ZIP64_LIMIT || entry.compressedSize > ZIP64_LIMIT || this._options.forceZip64) {
      entry.useZip64 = true;
    }

    // Write data descriptor
    const dd = this._buildDataDescriptor(entry);
    this._pushData(dd);

    this._entries.push({ entry, nameBytes });
  }

  private _writeData(
    entry: ZipArchiveEntry,
    source: Readable | Buffer,
  ): Promise<{ crc: number; size: number; compressedSize: number }> {
    return new Promise((resolve, reject) => {
      let crc = 0;
      let size = 0;
      let compressedSize = 0;

      const readable = Buffer.isBuffer(source)
        ? Readable.from([source])
        : source;

      if (entry.method === METHOD_STORE) {
        readable.on('data', (chunk: Buffer) => {
          crc = crc32(chunk, crc);
          size += chunk.length;
          compressedSize += chunk.length;
          this._pushData(chunk);
        });
        readable.on('end', () => resolve({ crc, size, compressedSize }));
        readable.on('error', reject);
      } else {
        // DEFLATE
        const level = this._options.zlib?.level ?? 6;
        const deflater = createDeflateRaw({ level });

        readable.on('data', (chunk: Buffer) => {
          crc = crc32(chunk, crc);
          size += chunk.length;
        });

        deflater.on('data', (chunk: Buffer) => {
          compressedSize += chunk.length;
          this._pushData(chunk);
        });

        deflater.on('end', () => resolve({ crc, size, compressedSize }));
        deflater.on('error', reject);
        readable.on('error', reject);

        readable.pipe(deflater);
      }
    });
  }

  finalize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._finalizeResolve = resolve;
      this._finalizeReject = reject;
      this._finalized = true;
      if (!this._processing && this._queue.length === 0) {
        this._writeCentralDirectory();
      }
    });
  }

  private _writeCentralDirectory(): void {
    const cdStart = this._offset;

    for (const record of this._entries) {
      const cdh = this._buildCentralDirHeader(record.entry, record.nameBytes);
      this._pushData(cdh);
    }

    const cdSize = this._offset - cdStart;
    const entryCount = this._entries.length;

    const needZip64 =
      this._options.forceZip64 ||
      entryCount > ZIP64_COUNT_LIMIT ||
      cdSize > ZIP64_LIMIT ||
      cdStart > ZIP64_LIMIT;

    if (needZip64) {
      this._writeZip64EndOfCentralDirectory(cdStart, cdSize, entryCount);
    }

    this._writeEndOfCentralDirectory(cdStart, cdSize, entryCount, needZip64);

    this.push(null); // end stream
    if (this._finalizeResolve) {
      this._finalizeResolve();
    }
  }

  private _pushData(buf: Buffer): void {
    this.push(buf);
    this._offset += buf.length;
  }

  private _buildLocalFileHeader(
    entry: ZipArchiveEntry,
    nameBytes: Buffer,
    useDataDescriptor: boolean,
  ): Buffer {
    const extraField = entry.useZip64 || this._options.forceZip64
      ? this._buildZip64ExtraField(0, 0, entry.offset)
      : Buffer.alloc(0);

    const buf = Buffer.alloc(30 + nameBytes.length + extraField.length);
    let pos = 0;

    // Signature
    buf.writeUInt32LE(SIG_LOCAL_FILE, pos); pos += 4;
    // Version needed
    const versionNeeded = entry.useZip64 || this._options.forceZip64
      ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFLATE;
    buf.writeUInt16LE(versionNeeded, pos); pos += 2;
    // General purpose bit flag (bit 3 = data descriptor, bit 11 = UTF-8)
    const flags = (useDataDescriptor ? 0x0008 : 0) | 0x0800;
    buf.writeUInt16LE(flags, pos); pos += 2;
    // Compression method
    buf.writeUInt16LE(entry.method, pos); pos += 2;
    // Last mod time / date
    const { time, date } = dosDateTime(entry.date);
    buf.writeUInt16LE(time, pos); pos += 2;
    buf.writeUInt16LE(date, pos); pos += 2;

    if (useDataDescriptor) {
      // CRC, compressed size, uncompressed size = 0 (in data descriptor)
      buf.writeUInt32LE(0, pos); pos += 4;
      buf.writeUInt32LE(0, pos); pos += 4;
      buf.writeUInt32LE(0, pos); pos += 4;
    } else {
      buf.writeUInt32LE(entry.crc, pos); pos += 4;
      buf.writeUInt32LE(
        entry.compressedSize > ZIP64_LIMIT ? 0xffffffff : entry.compressedSize, pos,
      ); pos += 4;
      buf.writeUInt32LE(
        entry.size > ZIP64_LIMIT ? 0xffffffff : entry.size, pos,
      ); pos += 4;
    }

    // Filename length
    buf.writeUInt16LE(nameBytes.length, pos); pos += 2;
    // Extra field length
    buf.writeUInt16LE(extraField.length, pos); pos += 2;
    // Filename
    nameBytes.copy(buf, pos); pos += nameBytes.length;
    // Extra field
    if (extraField.length > 0) {
      extraField.copy(buf, pos);
    }

    return buf;
  }

  private _buildDataDescriptor(entry: ZipArchiveEntry): Buffer {
    const useZip64 = entry.useZip64 || this._options.forceZip64;
    const buf = Buffer.alloc(useZip64 ? 24 : 16);
    let pos = 0;

    buf.writeUInt32LE(SIG_DATA_DESCRIPTOR, pos); pos += 4;
    buf.writeUInt32LE(entry.crc, pos); pos += 4;

    if (useZip64) {
      writeBigUInt64LE(buf, BigInt(entry.compressedSize), pos); pos += 8;
      writeBigUInt64LE(buf, BigInt(entry.size), pos);
    } else {
      buf.writeUInt32LE(entry.compressedSize, pos); pos += 4;
      buf.writeUInt32LE(entry.size, pos);
    }

    return buf;
  }

  private _buildCentralDirHeader(entry: ZipArchiveEntry, nameBytes: Buffer): Buffer {
    const commentBytes = entry.comment ? Buffer.from(entry.comment, 'utf8') : Buffer.alloc(0);
    const useZip64 = entry.useZip64 || this._options.forceZip64;
    const extraField = useZip64
      ? this._buildZip64ExtraField(entry.size, entry.compressedSize, entry.offset)
      : Buffer.alloc(0);

    const buf = Buffer.alloc(46 + nameBytes.length + extraField.length + commentBytes.length);
    let pos = 0;

    // Signature
    buf.writeUInt32LE(SIG_CENTRAL_DIR, pos); pos += 4;
    // Version made by
    buf.writeUInt16LE(VERSION_MADE_BY, pos); pos += 2;
    // Version needed
    buf.writeUInt16LE(useZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFLATE, pos); pos += 2;
    // General purpose bit flag (bit 3 = data descriptor, bit 11 = UTF-8)
    const flags = (entry.size > 0 || entry.compressedSize > 0 ? 0x0008 : 0) | 0x0800;
    buf.writeUInt16LE(flags, pos); pos += 2;
    // Compression method
    buf.writeUInt16LE(entry.method, pos); pos += 2;
    // Last mod time / date
    const { time, date } = dosDateTime(entry.date);
    buf.writeUInt16LE(time, pos); pos += 2;
    buf.writeUInt16LE(date, pos); pos += 2;
    // CRC-32
    buf.writeUInt32LE(entry.crc, pos); pos += 4;
    // Compressed size
    buf.writeUInt32LE(
      useZip64 ? 0xffffffff : entry.compressedSize, pos,
    ); pos += 4;
    // Uncompressed size
    buf.writeUInt32LE(
      useZip64 ? 0xffffffff : entry.size, pos,
    ); pos += 4;
    // Filename length
    buf.writeUInt16LE(nameBytes.length, pos); pos += 2;
    // Extra field length
    buf.writeUInt16LE(extraField.length, pos); pos += 2;
    // File comment length
    buf.writeUInt16LE(commentBytes.length, pos); pos += 2;
    // Disk number start
    buf.writeUInt16LE(0, pos); pos += 2;
    // Internal file attributes
    buf.writeUInt16LE(0, pos); pos += 2;
    // External file attributes (Unix mode in upper 16 bits)
    buf.writeUInt32LE((entry.mode << 16) >>> 0, pos); pos += 4;
    // Relative offset of local header
    buf.writeUInt32LE(
      useZip64 ? 0xffffffff : entry.offset, pos,
    ); pos += 4;
    // Filename
    nameBytes.copy(buf, pos); pos += nameBytes.length;
    // Extra field
    if (extraField.length > 0) {
      extraField.copy(buf, pos); pos += extraField.length;
    }
    // Comment
    if (commentBytes.length > 0) {
      commentBytes.copy(buf, pos);
    }

    return buf;
  }

  private _buildZip64ExtraField(
    uncompressedSize: number,
    compressedSize: number,
    offset: number,
  ): Buffer {
    const buf = Buffer.alloc(28);
    let pos = 0;

    // Header ID for ZIP64 extended information
    buf.writeUInt16LE(0x0001, pos); pos += 2;
    // Data size
    buf.writeUInt16LE(24, pos); pos += 2;
    // Original uncompressed size
    writeBigUInt64LE(buf, BigInt(uncompressedSize), pos); pos += 8;
    // Compressed size
    writeBigUInt64LE(buf, BigInt(compressedSize), pos); pos += 8;
    // Offset of local header
    writeBigUInt64LE(buf, BigInt(offset), pos);

    return buf;
  }

  private _writeZip64EndOfCentralDirectory(
    cdStart: number,
    cdSize: number,
    entryCount: number,
  ): void {
    // ZIP64 end of central directory record
    const z64eocdr = Buffer.alloc(56);
    let pos = 0;

    z64eocdr.writeUInt32LE(SIG_ZIP64_END_CENTRAL_DIR, pos); pos += 4;
    // Size of this record (minus 12 bytes for sig + size field)
    writeBigUInt64LE(z64eocdr, BigInt(44), pos); pos += 8;
    // Version made by
    z64eocdr.writeUInt16LE(VERSION_MADE_BY, pos); pos += 2;
    // Version needed
    z64eocdr.writeUInt16LE(VERSION_NEEDED_ZIP64, pos); pos += 2;
    // Disk number
    z64eocdr.writeUInt32LE(0, pos); pos += 4;
    // Disk with central directory
    z64eocdr.writeUInt32LE(0, pos); pos += 4;
    // Total entries on this disk
    writeBigUInt64LE(z64eocdr, BigInt(entryCount), pos); pos += 8;
    // Total entries
    writeBigUInt64LE(z64eocdr, BigInt(entryCount), pos); pos += 8;
    // Central directory size
    writeBigUInt64LE(z64eocdr, BigInt(cdSize), pos); pos += 8;
    // Central directory offset
    writeBigUInt64LE(z64eocdr, BigInt(cdStart), pos);

    this._pushData(z64eocdr);

    // ZIP64 end of central directory locator
    const z64eocdl = Buffer.alloc(20);
    pos = 0;

    z64eocdl.writeUInt32LE(SIG_ZIP64_END_CENTRAL_DIR_LOCATOR, pos); pos += 4;
    // Disk with ZIP64 EOCD
    z64eocdl.writeUInt32LE(0, pos); pos += 4;
    // Offset of ZIP64 EOCD
    writeBigUInt64LE(z64eocdl, BigInt(cdStart + cdSize), pos); pos += 8;
    // Total disks
    z64eocdl.writeUInt32LE(1, pos);

    this._pushData(z64eocdl);
  }

  private _writeEndOfCentralDirectory(
    cdStart: number,
    cdSize: number,
    entryCount: number,
    needZip64: boolean,
  ): void {
    const commentBytes = this._options.comment
      ? Buffer.from(this._options.comment, 'utf8')
      : Buffer.alloc(0);

    const buf = Buffer.alloc(22 + commentBytes.length);
    let pos = 0;

    // Signature
    buf.writeUInt32LE(SIG_END_CENTRAL_DIR, pos); pos += 4;
    // Disk number
    buf.writeUInt16LE(0, pos); pos += 2;
    // Disk with central directory
    buf.writeUInt16LE(0, pos); pos += 2;
    // Total entries on this disk
    buf.writeUInt16LE(
      needZip64 ? 0xffff : entryCount, pos,
    ); pos += 2;
    // Total entries
    buf.writeUInt16LE(
      needZip64 ? 0xffff : entryCount, pos,
    ); pos += 2;
    // Central directory size
    buf.writeUInt32LE(
      needZip64 ? 0xffffffff : cdSize, pos,
    ); pos += 4;
    // Central directory offset
    buf.writeUInt32LE(
      needZip64 ? 0xffffffff : cdStart, pos,
    ); pos += 4;
    // Comment length
    buf.writeUInt16LE(commentBytes.length, pos); pos += 2;
    // Comment
    if (commentBytes.length > 0) {
      commentBytes.copy(buf, pos);
    }

    this._pushData(buf);
  }
}

// Convert JS Date to DOS date/time
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() >> 1) & 0x1f);

  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);

  return { time, date };
}

// Write a BigInt as 64-bit unsigned LE
function writeBigUInt64LE(buf: Buffer, value: bigint, offset: number): void {
  buf.writeBigUInt64LE(value, offset);
}
