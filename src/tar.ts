import { Transform, Readable } from 'node:stream';
import { createGzip, type ZlibOptions } from 'node:zlib';

const BLOCK_SIZE = 512;
const USTAR_MAGIC = 'ustar\0';
const USTAR_VERSION = '00';
const MAX_USTAR_PATH = 255;
const MAX_USTAR_NAME = 100;
const MAX_USTAR_PREFIX = 155;
const MAX_OCTAL_SIZE = 0o77777777777; // 8GB - 1

// TAR type flags
const TYPEFLAG_FILE = '0';
const TYPEFLAG_DIRECTORY = '5';
const TYPEFLAG_SYMLINK = '2';
const TYPEFLAG_PAX = 'x'; // PAX extended header for next entry

export interface TarEntryOptions {
  name: string;
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: Date;
  type?: '0' | '5' | '2';
  linkname?: string;
  uname?: string;
  gname?: string;
}

export class TarArchiveEntry {
  name: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: Date;
  type: string;
  linkname: string;
  uname: string;
  gname: string;

  constructor(opts: TarEntryOptions) {
    this.name = opts.name;
    this.size = opts.size ?? 0;
    this.mode = opts.mode ?? (opts.type === '5' ? 0o755 : 0o644);
    this.uid = opts.uid ?? 0;
    this.gid = opts.gid ?? 0;
    this.mtime = opts.mtime ?? new Date();
    this.type = opts.type ?? TYPEFLAG_FILE;
    this.linkname = opts.linkname ?? '';
    this.uname = opts.uname ?? '';
    this.gname = opts.gname ?? '';
  }
}

export interface TarOutputStreamOptions {
  gzip?: boolean;
  gzipOptions?: ZlibOptions;
}

export class TarArchiveOutputStream extends Transform {
  private _options: TarOutputStreamOptions;
  private _offset = 0;
  private _processing = false;
  private _queue: Array<{ entry: TarArchiveEntry; source: Readable | Buffer | null }> = [];
  private _finalized = false;
  private _finalizeResolve: (() => void) | null = null;
  private _gzipStream: Transform | null = null;

  constructor(options: TarOutputStreamOptions = {}) {
    super();
    this._options = options;

    if (options.gzip) {
      this._gzipStream = createGzip(options.gzipOptions ?? {});
    }
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    callback(null, chunk);
  }

  entry(entry: TarArchiveEntry, source: Readable | Buffer | string | null): void {
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
          this._writeEof();
        }
      })
      .catch((err) => {
        this.destroy(err as Error);
      });
  }

  private async _writeEntry(entry: TarArchiveEntry, source: Readable | Buffer | null): Promise<void> {
    // Buffer stream sources to know size before writing header
    let dataBuf: Buffer | null = null;

    if (entry.type === TYPEFLAG_DIRECTORY || source === null) {
      entry.size = 0;
    } else if (Buffer.isBuffer(source)) {
      dataBuf = source;
      entry.size = source.length;
    } else {
      // Stream source — must buffer to know size
      dataBuf = await this._bufferStream(source);
      entry.size = dataBuf.length;
    }

    // Check if PAX headers are needed
    const needPax = entry.name.length > MAX_USTAR_PATH ||
      entry.linkname.length > MAX_USTAR_NAME ||
      entry.size > MAX_OCTAL_SIZE;

    if (needPax) {
      this._writePaxHeaders(entry);
    }

    // Write ustar header
    const header = this._buildHeader(entry, needPax);
    this._pushData(header);

    // Write data + padding
    if (dataBuf && dataBuf.length > 0) {
      this._pushData(dataBuf);
      const remainder = dataBuf.length % BLOCK_SIZE;
      if (remainder > 0) {
        this._pushData(Buffer.alloc(BLOCK_SIZE - remainder));
      }
    }
  }

  private _bufferStream(source: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      source.on('data', (chunk: Buffer) => chunks.push(chunk));
      source.on('end', () => resolve(Buffer.concat(chunks)));
      source.on('error', reject);
    });
  }

  private _writePaxHeaders(entry: TarArchiveEntry): void {
    const records: string[] = [];

    if (entry.name.length > MAX_USTAR_PATH) {
      records.push(paxRecord('path', entry.name));
    }
    if (entry.linkname.length > MAX_USTAR_NAME) {
      records.push(paxRecord('linkpath', entry.linkname));
    }
    if (entry.size > MAX_OCTAL_SIZE) {
      records.push(paxRecord('size', String(entry.size)));
    }

    const paxData = Buffer.from(records.join(''), 'utf8');

    // Write PAX header entry
    const paxEntry = new TarArchiveEntry({
      name: 'PaxHeader/' + entry.name.slice(0, 80),
      size: paxData.length,
      type: TYPEFLAG_PAX as '0',
    });

    const header = this._buildHeader(paxEntry, false);
    this._pushData(header);
    this._pushData(paxData);

    const remainder = paxData.length % BLOCK_SIZE;
    if (remainder > 0) {
      this._pushData(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }

  private _buildHeader(entry: TarArchiveEntry, hasPax: boolean): Buffer {
    const buf = Buffer.alloc(BLOCK_SIZE);

    // Split path into name (100) and prefix (155) for ustar
    let name = entry.name;
    let prefix = '';

    if (!hasPax && name.length > MAX_USTAR_NAME) {
      // Try to split at directory separator
      const splitIdx = name.lastIndexOf('/', MAX_USTAR_PREFIX);
      if (splitIdx > 0 && name.length - splitIdx - 1 <= MAX_USTAR_NAME) {
        prefix = name.slice(0, splitIdx);
        name = name.slice(splitIdx + 1);
      }
      // If still too long and we have PAX, truncate
    }

    // name (0, 100)
    writeString(buf, name.slice(0, MAX_USTAR_NAME), 0, MAX_USTAR_NAME);
    // mode (100, 8)
    writeOctal(buf, entry.mode & 0o7777, 100, 8);
    // uid (108, 8)
    writeOctal(buf, entry.uid, 108, 8);
    // gid (116, 8)
    writeOctal(buf, entry.gid, 116, 8);
    // size (124, 12)
    if (entry.size > MAX_OCTAL_SIZE && !hasPax) {
      // Write binary size for >8GB (GNU extension fallback)
      writeBinarySize(buf, entry.size, 124);
    } else {
      writeOctal(buf, Math.min(entry.size, MAX_OCTAL_SIZE), 124, 12);
    }
    // mtime (136, 12)
    writeOctal(buf, Math.floor(entry.mtime.getTime() / 1000), 136, 12);
    // checksum placeholder (148, 8) — filled after
    buf.fill(0x20, 148, 156); // spaces
    // typeflag (156, 1)
    buf.write(entry.type || TYPEFLAG_FILE, 156, 1, 'ascii');
    // linkname (157, 100)
    if (entry.linkname) {
      writeString(buf, entry.linkname.slice(0, 100), 157, 100);
    }
    // magic (257, 6)
    buf.write(USTAR_MAGIC, 257, 6, 'ascii');
    // version (263, 2)
    buf.write(USTAR_VERSION, 263, 2, 'ascii');
    // uname (265, 32)
    if (entry.uname) {
      writeString(buf, entry.uname.slice(0, 32), 265, 32);
    }
    // gname (297, 32)
    if (entry.gname) {
      writeString(buf, entry.gname.slice(0, 32), 297, 32);
    }
    // prefix (345, 155)
    if (prefix) {
      writeString(buf, prefix.slice(0, MAX_USTAR_PREFIX), 345, MAX_USTAR_PREFIX);
    }

    // Calculate and write checksum
    let chksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      chksum += buf[i];
    }
    writeOctal(buf, chksum, 148, 7);
    buf[155] = 0x20; // trailing space

    return buf;
  }

  finalize(): Promise<void> {
    return new Promise((resolve) => {
      this._finalizeResolve = resolve;
      this._finalized = true;
      if (!this._processing && this._queue.length === 0) {
        this._writeEof();
      }
    });
  }

  private _writeEof(): void {
    // Two 512-byte zero blocks mark end of archive
    this._pushData(Buffer.alloc(BLOCK_SIZE * 2));

    if (this._gzipStream) {
      // Pipe all buffered data through gzip is handled at a higher level
      // For the standalone TAR output stream, gzip wrapping is done by the consumer
    }

    this.push(null);
    if (this._finalizeResolve) {
      this._finalizeResolve();
    }
  }

  private _pushData(buf: Buffer): void {
    this.push(buf);
    this._offset += buf.length;
  }
}

// Write a null-terminated string into buf at offset
function writeString(buf: Buffer, str: string, offset: number, length: number): void {
  const bytes = Buffer.from(str, 'utf8');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

// Write an octal number, null-terminated, right-aligned with leading zeros
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const str = value.toString(8);
  const padded = str.padStart(length - 1, '0');
  buf.write(padded, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

// Write binary size (for >8GB files, big-endian with high bit set)
function writeBinarySize(buf: Buffer, size: number, offset: number): void {
  buf[offset] = 0x80; // high bit indicates binary encoding
  const bigSize = BigInt(size);
  for (let i = 11; i > 0; i--) {
    buf[offset + i] = Number(bigSize >> BigInt((11 - i) * 8) & BigInt(0xff));
  }
}

// Build a PAX extended header record: "length key=value\n"
function paxRecord(key: string, value: string): string {
  // The record format is: "LEN key=value\n" where LEN includes itself
  const base = ` ${key}=${value}\n`;
  let len = base.length + 1; // +1 for at least 1 digit
  // Recalculate if digit count changes the length
  const digits = String(len).length;
  len = base.length + digits;
  if (String(len).length !== digits) {
    len = base.length + String(len).length;
  }
  return `${len}${base}`;
}
