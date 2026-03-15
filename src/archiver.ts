import { Transform, Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import type {
  ArchiveFormat,
  ArchiveOptions,
  ZipOptions,
  TarOptions,
  EntryData,
  ProgressData,
} from './types.js';
import { ZipArchiveEntry, ZipArchiveOutputStream } from './zip.js';
import { TarArchiveEntry, TarArchiveOutputStream } from './tar.js';
import { globWalk } from './glob.js';
import type { GlobOptions } from './glob.js';

interface QueueItem {
  type: 'append' | 'file' | 'directory' | 'glob' | 'symlink';
  source?: Readable | Buffer | string | null;
  data: EntryData;
  filepath?: string;
  dirpath?: string;
  destpath?: string;
  pattern?: string;
  globOptions?: GlobOptions;
  target?: string;
}

export class Archiver extends Transform {
  private _format: ArchiveFormat;
  private _options: ArchiveOptions;
  private _pointer = 0;
  private _entriesCount = 0;
  private _entriesProcessedCount = 0;
  private _fsProcessedBytes = 0;
  private _fsTotalBytes = 0;
  private _finalized = false;
  private _aborted = false;
  private _queue: QueueItem[] = [];
  private _processing = false;
  private _pendingAsync = 0;
  private _statConcurrency: number;
  private _formatStream: ZipArchiveOutputStream | TarArchiveOutputStream;
  private _gzipStream: Transform | null = null;
  private _finalizePromise: Promise<void> | null = null;
  private _finalizeResolve: (() => void) | null = null;
  private _finalizeReject: ((err: Error) => void) | null = null;

  constructor(format: ArchiveFormat, options: ArchiveOptions = {}) {
    super();
    this._format = format;
    this._options = options;
    this._statConcurrency = (options as ZipOptions | TarOptions).statConcurrency ?? 4;

    if (format === 'zip') {
      const zipOpts = options as ZipOptions;
      this._formatStream = new ZipArchiveOutputStream({
        zlib: zipOpts.zlib,
        store: zipOpts.store,
        comment: zipOpts.comment,
        forceLocalTime: zipOpts.forceLocalTime,
        forceZip64: zipOpts.forceZip64,
        namePrependSlash: zipOpts.namePrependSlash,
      });
    } else if (format === 'tar') {
      // Raw TAR stream; gzip wrapping handled separately
      this._formatStream = new TarArchiveOutputStream();
      const tarOpts = options as TarOptions;
      if (tarOpts.gzip) {
        this._gzipStream = createGzip(tarOpts.gzipOptions as Record<string, unknown> ?? {});
      }
    } else {
      throw new Error(`Unsupported format: ${format}`);
    }

    // Pipe format stream (and optional gzip) output to this Transform
    const source = this._gzipStream
      ? this._formatStream.pipe(this._gzipStream)
      : this._formatStream;

    source.on('data', (chunk: Buffer) => {
      this._pointer += chunk.length;
      this.push(chunk);
    });

    source.on('end', () => {
      this.push(null);
    });

    this._formatStream.on('error', (err: Error) => {
      this.emit('error', err);
    });

    if (this._gzipStream) {
      this._gzipStream.on('error', (err: Error) => {
        this.emit('error', err);
      });
    }
  }

  _transform(
    _chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    // Data flows from formatStream -> this, not written directly
    callback();
  }

  _flush(callback: (error?: Error | null) => void): void {
    callback();
  }

  get format(): ArchiveFormat {
    return this._format;
  }

  pointer(): number {
    return this._pointer;
  }

  progress(): ProgressData {
    return {
      entries: {
        total: this._entriesCount,
        processed: this._entriesProcessedCount,
      },
      fs: {
        totalBytes: this._fsTotalBytes,
        processedBytes: this._fsProcessedBytes,
      },
    };
  }

  append(
    source: Readable | Buffer | string,
    data: EntryData,
  ): this {
    if (this._finalized) throw new Error('Archive already finalized');
    if (this._aborted) throw new Error('Archive aborted');

    this._entriesCount++;
    this._queue.push({ type: 'append', source, data });
    this._processQueue();
    return this;
  }

  file(filepath: string, data: EntryData = {}): this {
    if (this._finalized) throw new Error('Archive already finalized');
    if (this._aborted) throw new Error('Archive aborted');

    this._entriesCount++;
    this._queue.push({ type: 'file', filepath, data });
    this._processQueue();
    return this;
  }

  directory(dirpath: string, destpath?: string | false, data?: EntryData): this {
    if (this._finalized) throw new Error('Archive already finalized');
    if (this._aborted) throw new Error('Archive aborted');

    const dest = destpath === false ? '' : (destpath ?? '');
    this._queue.push({ type: 'directory', dirpath, destpath: dest, data: data ?? {} });
    this._processQueue();
    return this;
  }

  glob(pattern: string, options?: GlobOptions, data?: EntryData): this {
    if (this._finalized) throw new Error('Archive already finalized');
    if (this._aborted) throw new Error('Archive aborted');

    this._queue.push({ type: 'glob', pattern, globOptions: options ?? {}, data: data ?? {} });
    this._processQueue();
    return this;
  }

  symlink(filepath: string, target: string, mode?: number): this {
    if (this._finalized) throw new Error('Archive already finalized');
    if (this._aborted) throw new Error('Archive aborted');

    this._entriesCount++;
    this._queue.push({
      type: 'symlink',
      data: { name: filepath, mode, type: 'symlink' },
      target,
    });
    this._processQueue();
    return this;
  }

  finalize(): Promise<void> {
    if (this._finalizePromise) return this._finalizePromise;
    this._finalized = true;

    this._finalizePromise = new Promise<void>((resolve, reject) => {
      this._finalizeResolve = resolve;
      this._finalizeReject = reject;

      if (!this._processing && this._queue.length === 0 && this._pendingAsync === 0) {
        this._doFinalize();
      }
    });

    return this._finalizePromise;
  }

  abort(): this {
    this._aborted = true;
    this._queue.length = 0;
    this._formatStream.destroy();
    if (this._gzipStream) this._gzipStream.destroy();
    this.destroy();
    return this;
  }

  setFormat(format: ArchiveFormat): this {
    this._format = format;
    return this;
  }

  setModule(_module: unknown): this {
    // For API compatibility
    return this;
  }

  private _processQueue(): void {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const item = this._queue.shift()!;

    this._processItem(item)
      .then(() => {
        this._processing = false;
        if (this._queue.length > 0) {
          this._processQueue();
        } else if (this._finalized && this._pendingAsync === 0) {
          this._doFinalize();
        }
      })
      .catch((err) => {
        this._processing = false;
        this.emit('error', err);
      });
  }

  private async _processItem(item: QueueItem): Promise<void> {
    switch (item.type) {
      case 'append':
        await this._processAppend(item);
        break;
      case 'file':
        await this._processFile(item);
        break;
      case 'directory':
        await this._processDirectory(item);
        break;
      case 'glob':
        await this._processGlob(item);
        break;
      case 'symlink':
        await this._processSymlink(item);
        break;
    }
  }

  private async _processAppend(item: QueueItem): Promise<void> {
    const source = item.source!;
    const data = item.data;
    const name = data.name ?? 'unnamed';

    if (this._format === 'zip') {
      const entry = new ZipArchiveEntry({
        name,
        date: data.date ? new Date(data.date as string | number) : undefined,
        mode: data.mode,
        store: data.store ?? (this._options as ZipOptions).store,
        comment: data.comment,
        isDirectory: data.type === 'directory',
      });
      (this._formatStream as ZipArchiveOutputStream).entry(entry, source);
    } else {
      const entry = new TarArchiveEntry({
        name,
        mode: data.mode,
        mtime: data.date ? new Date(data.date as string | number) : undefined,
        type: data.type === 'directory' ? '5' : '0',
      });
      (this._formatStream as TarArchiveOutputStream).entry(entry, source);
    }

    this._entriesProcessedCount++;
    this.emit('entry', data);
    this._emitProgress();
  }

  private async _processFile(item: QueueItem): Promise<void> {
    const filepath = resolve(item.filepath!);
    const data = item.data;

    try {
      const stats = await stat(filepath);
      const name = data.name ?? item.filepath!;
      const normalizedName = normalizePath(data.prefix ? data.prefix + '/' + name : name);

      this._fsTotalBytes += stats.size;
      this._fsProcessedBytes += stats.size;

      const source = createReadStream(filepath);

      if (this._format === 'zip') {
        const entry = new ZipArchiveEntry({
          name: normalizedName,
          date: data.date ? new Date(data.date as string | number) : stats.mtime,
          mode: data.mode ?? stats.mode,
          store: data.store ?? (this._options as ZipOptions).store,
          comment: data.comment,
        });
        (this._formatStream as ZipArchiveOutputStream).entry(entry, source);
      } else {
        const entry = new TarArchiveEntry({
          name: normalizedName,
          mode: data.mode ?? stats.mode & 0o7777,
          mtime: data.date ? new Date(data.date as string | number) : stats.mtime,
          uid: stats.uid,
          gid: stats.gid,
        });
        (this._formatStream as TarArchiveOutputStream).entry(entry, source);
      }

      this._entriesProcessedCount++;
      this.emit('entry', { ...data, name: normalizedName, sourcePath: filepath });
      this._emitProgress();
    } catch (err) {
      this.emit('warning', err);
    }
  }

  private async _processDirectory(item: QueueItem): Promise<void> {
    const dirpath = resolve(item.dirpath!);
    const destpath = item.destpath ?? '';

    try {
      const entries = await this._readDirRecursive(dirpath);

      for (const entry of entries) {
        this._entriesCount++;
        const relPath = relative(dirpath, entry.absolute);
        const archivePath = destpath
          ? normalizePath(destpath + '/' + relPath)
          : normalizePath(relPath);

        if (entry.isDirectory) {
          const dirName = archivePath.endsWith('/') ? archivePath : archivePath + '/';
          if (this._format === 'zip') {
            (this._formatStream as ZipArchiveOutputStream).entry(
              new ZipArchiveEntry({ name: dirName, isDirectory: true }),
              null,
            );
          } else {
            (this._formatStream as TarArchiveOutputStream).entry(
              new TarArchiveEntry({ name: dirName, type: '5' }),
              null,
            );
          }
        } else {
          const stats = await stat(entry.absolute);
          this._fsTotalBytes += stats.size;
          this._fsProcessedBytes += stats.size;
          const source = createReadStream(entry.absolute);

          if (this._format === 'zip') {
            (this._formatStream as ZipArchiveOutputStream).entry(
              new ZipArchiveEntry({
                name: archivePath,
                date: stats.mtime,
                mode: stats.mode,
              }),
              source,
            );
          } else {
            (this._formatStream as TarArchiveOutputStream).entry(
              new TarArchiveEntry({
                name: archivePath,
                mode: stats.mode & 0o7777,
                mtime: stats.mtime,
                uid: stats.uid,
                gid: stats.gid,
              }),
              source,
            );
          }
        }

        this._entriesProcessedCount++;
        this.emit('entry', { name: archivePath });
        this._emitProgress();
      }
    } catch (err) {
      this.emit('warning', err);
    }
  }

  private async _processGlob(item: QueueItem): Promise<void> {
    try {
      const matches = await globWalk(item.pattern!, item.globOptions);

      for (const match of matches) {
        if (match.isDirectory) continue; // Only files for glob

        this._entriesCount++;
        const name = normalizePath(
          item.data.prefix ? item.data.prefix + '/' + match.path : match.path,
        );

        const stats = await stat(match.absolute);
        this._fsTotalBytes += stats.size;
        this._fsProcessedBytes += stats.size;
        const source = createReadStream(match.absolute);

        if (this._format === 'zip') {
          (this._formatStream as ZipArchiveOutputStream).entry(
            new ZipArchiveEntry({
              name,
              date: stats.mtime,
              mode: stats.mode,
            }),
            source,
          );
        } else {
          (this._formatStream as TarArchiveOutputStream).entry(
            new TarArchiveEntry({
              name,
              mode: stats.mode & 0o7777,
              mtime: stats.mtime,
              uid: stats.uid,
              gid: stats.gid,
            }),
            source,
          );
        }

        this._entriesProcessedCount++;
        this.emit('entry', { name, sourcePath: match.absolute });
        this._emitProgress();
      }
    } catch (err) {
      this.emit('warning', err);
    }
  }

  private async _processSymlink(item: QueueItem): Promise<void> {
    const name = item.data.name!;
    const target = item.target!;

    if (this._format === 'zip') {
      // ZIP doesn't natively support symlinks well; add as a file with symlink content
      const entry = new ZipArchiveEntry({
        name,
        mode: item.data.mode ?? 0o120755,
        store: true,
      });
      (this._formatStream as ZipArchiveOutputStream).entry(entry, target);
    } else {
      const entry = new TarArchiveEntry({
        name,
        type: '2',
        linkname: target,
        mode: item.data.mode ?? 0o755,
      });
      (this._formatStream as TarArchiveOutputStream).entry(entry, null);
    }

    this._entriesProcessedCount++;
    this.emit('entry', { name, type: 'symlink' });
    this._emitProgress();
  }

  private async _readDirRecursive(
    dirpath: string,
  ): Promise<Array<{ absolute: string; isDirectory: boolean }>> {
    const results: Array<{ absolute: string; isDirectory: boolean }> = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const isDir = entry.isDirectory();
        results.push({ absolute: abs, isDirectory: isDir });
        if (isDir) {
          await walk(abs);
        }
      }
    };

    await walk(dirpath);
    return results;
  }

  private async _doFinalize(): Promise<void> {
    try {
      await this._formatStream.finalize();
      if (this._finalizeResolve) {
        this._finalizeResolve();
      }
    } catch (err) {
      if (this._finalizeReject) {
        this._finalizeReject(err as Error);
      }
    }
  }

  private _emitProgress(): void {
    this.emit('progress', this.progress());
  }
}

export function createArchiver(
  format: ArchiveFormat,
  options: ArchiveOptions = {},
): Archiver {
  return new Archiver(format, options);
}

function normalizePath(p: string): string {
  // Convert Windows paths to POSIX
  return p.split(sep).join('/').replace(/\/+/g, '/');
}
