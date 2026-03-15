import { Transform, Readable, Writable } from 'node:stream';

export interface ZipOptions {
  zlib?: { level?: number };
  store?: boolean;
  comment?: string;
  forceLocalTime?: boolean;
  forceZip64?: boolean;
  namePrependSlash?: boolean;
  statConcurrency?: number;
}

export interface TarOptions {
  gzip?: boolean;
  gzipOptions?: Record<string, unknown>;
  statConcurrency?: number;
}

export type ArchiveFormat = 'zip' | 'tar';
export type ArchiveOptions = ZipOptions | TarOptions;

export interface EntryData {
  name?: string;
  prefix?: string;
  date?: Date | string;
  mode?: number;
  store?: boolean;
  comment?: string;
  type?: 'file' | 'directory' | 'symlink';
  sourcePath?: string;
  stats?: EntryStats;
  _sourceType?: 'stream' | 'buffer' | 'string';
}

export interface EntryStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
  mtime: Date;
  uid?: number;
  gid?: number;
}

export interface ProgressData {
  entries: {
    total: number;
    processed: number;
  };
  fs: {
    totalBytes: number;
    processedBytes: number;
  };
}


export interface ArchiveEntry {
  name: string;
  size: number;
  date: Date;
  mode: number;
  type: string;
  sourcePath?: string;
  comment?: string;
  source: Readable | Buffer | string | null;
}

export interface FormatModule {
  append(entry: ArchiveEntry, options: ArchiveOptions): void;
  finalize(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  pipe(destination: Writable): Writable;
}
