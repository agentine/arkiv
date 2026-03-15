import { describe, it, expect } from 'vitest';
import arkiv, {
  createArchiver,
  Archiver,
  crc32,
  ZipArchiveEntry,
  ZipArchiveOutputStream,
  TarArchiveEntry,
  TarArchiveOutputStream,
  GlobWalker,
} from '../src/index.js';

describe('scaffold', () => {
  it('default export is createArchiver factory', () => {
    expect(typeof arkiv).toBe('function');
    expect(arkiv).toBe(createArchiver);
  });

  it('createArchiver returns an Archiver instance', () => {
    const archive = createArchiver('zip');
    expect(archive).toBeInstanceOf(Archiver);
    expect(archive.format).toBe('zip');
  });

  it('Archiver tracks pointer', () => {
    const archive = createArchiver('tar');
    expect(archive.pointer()).toBe(0);
  });

  it('Archiver reports progress', () => {
    const archive = createArchiver('zip');
    const progress = archive.progress();
    expect(progress.entries.total).toBe(0);
    expect(progress.entries.processed).toBe(0);
    expect(progress.fs.totalBytes).toBe(0);
    expect(progress.fs.processedBytes).toBe(0);
  });

  it('exports CRC32 function', () => {
    expect(typeof crc32).toBe('function');
  });

  it('exports ZIP classes', () => {
    expect(ZipArchiveEntry).toBeDefined();
    expect(ZipArchiveOutputStream).toBeDefined();
  });

  it('exports TAR classes', () => {
    expect(TarArchiveEntry).toBeDefined();
    expect(TarArchiveOutputStream).toBeDefined();
  });

  it('exports GlobWalker', () => {
    expect(GlobWalker).toBeDefined();
  });
});
