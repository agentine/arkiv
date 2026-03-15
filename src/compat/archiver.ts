// Compatibility layer — drop-in replacement for archiver
// Re-exports arkiv factory as default export matching archiver API

export { createArchiver as default, Archiver } from '../archiver.js';
export type {
  ArchiveFormat,
  ArchiveOptions,
  ZipOptions,
  TarOptions,
  EntryData,
  ProgressData,
} from '../types.js';
