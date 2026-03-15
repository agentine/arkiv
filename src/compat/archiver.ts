// Compatibility layer — drop-in replacement for archiver
// Usage:
//   import archiver from '@agentine/arkiv/compat/archiver';
//   const archive = archiver('zip', { zlib: { level: 9 } });

import { createArchiver, Archiver } from '../archiver.js';
import type { ArchiveFormat, ArchiveOptions } from '../types.js';

// Match archiver's default export: a factory function
function archiver(format: ArchiveFormat, options?: ArchiveOptions): Archiver {
  return createArchiver(format, options);
}

// archiver.create() is an alias for the factory
archiver.create = createArchiver;

// archiver.isRegisteredFormat() — always returns true for zip/tar
archiver.isRegisteredFormat = (format: string): boolean => {
  return format === 'zip' || format === 'tar';
};

// archiver.registerFormat() — no-op for compatibility
archiver.registerFormat = (_format: string, _module: unknown): void => {
  // no-op — arkiv has built-in formats only
};

export default archiver;
export { Archiver };
export { createArchiver };
export type {
  ArchiveFormat,
  ArchiveOptions,
  ZipOptions,
  TarOptions,
  EntryData,
  ProgressData,
} from '../types.js';
