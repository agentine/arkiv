// Core Archiver class — streaming archive engine
// Placeholder — full implementation in Phase 4

import { Transform } from 'node:stream';
import type {
  ArchiveFormat,
  ArchiveOptions,
  EntryData,
  ProgressData,
} from './types.js';

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

  constructor(format: ArchiveFormat, options: ArchiveOptions = {}) {
    super();
    this._format = format;
    this._options = options;
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this._pointer += chunk.length;
    callback(null, chunk);
  }

  pointer(): number {
    return this._pointer;
  }

  get format(): ArchiveFormat {
    return this._format;
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
}

export function createArchiver(
  format: ArchiveFormat,
  options: ArchiveOptions = {},
): Archiver {
  return new Archiver(format, options);
}
