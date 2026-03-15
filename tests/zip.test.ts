import { describe, it, expect } from 'vitest';
import { Writable, Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchiveEntry, ZipArchiveOutputStream } from '../src/zip.js';

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('ZipArchiveEntry', () => {
  it('creates entry with defaults', () => {
    const entry = new ZipArchiveEntry({ name: 'test.txt' });
    expect(entry.name).toBe('test.txt');
    expect(entry.method).toBe(8); // DEFLATE
    expect(entry.mode).toBe(0o100644);
    expect(entry.isDirectory).toBe(false);
    expect(entry.comment).toBe('');
    expect(entry.date).toBeInstanceOf(Date);
  });

  it('creates directory entry', () => {
    const entry = new ZipArchiveEntry({ name: 'dir/', isDirectory: true });
    expect(entry.method).toBe(0); // STORE
    expect(entry.isDirectory).toBe(true);
    expect(entry.mode).toBe(0o40755);
  });

  it('creates stored entry', () => {
    const entry = new ZipArchiveEntry({ name: 'file.txt', store: true });
    expect(entry.method).toBe(0); // STORE
  });

  it('accepts custom date and mode', () => {
    const d = new Date(2020, 5, 15, 10, 30, 0);
    const entry = new ZipArchiveEntry({ name: 'a.txt', date: d, mode: 0o100755 });
    expect(entry.date).toBe(d);
    expect(entry.mode).toBe(0o100755);
  });
});

describe('ZipArchiveOutputStream', () => {
  it('creates valid empty ZIP archive', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);
    await stream.finalize();
    const buf = await resultPromise;

    // End of central directory signature at end
    expect(buf.length).toBeGreaterThanOrEqual(22);
    // EOCD signature
    const eocdSig = buf.readUInt32LE(buf.length - 22);
    expect(eocdSig).toBe(0x06054b50);
    // 0 entries
    expect(buf.readUInt16LE(buf.length - 22 + 8)).toBe(0);
  });

  it('creates ZIP with a single stored file', async () => {
    const stream = new ZipArchiveOutputStream({ store: true });
    const resultPromise = collectStream(stream);

    const entry = new ZipArchiveEntry({ name: 'hello.txt', store: true });
    stream.entry(entry, Buffer.from('Hello, World!'));
    await stream.finalize();
    const buf = await resultPromise;

    // Local file header signature
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    // The content "Hello, World!" should appear in the archive
    expect(buf.includes(Buffer.from('Hello, World!'))).toBe(true);
  });

  it('creates ZIP with a deflated file', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const entry = new ZipArchiveEntry({ name: 'data.txt' });
    const content = 'A'.repeat(1000);
    stream.entry(entry, Buffer.from(content));
    await stream.finalize();
    const buf = await resultPromise;

    // Should be smaller than raw content due to compression
    expect(buf.length).toBeLessThan(1000 + 200); // some overhead for headers
    // Local file header present
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('creates ZIP with multiple files', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'file1.txt' }),
      Buffer.from('Content 1'),
    );
    stream.entry(
      new ZipArchiveEntry({ name: 'file2.txt' }),
      Buffer.from('Content 2'),
    );
    stream.entry(
      new ZipArchiveEntry({ name: 'file3.txt' }),
      Buffer.from('Content 3'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Count central directory entries
    let cdCount = 0;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x02014b50) cdCount++;
    }
    expect(cdCount).toBe(3);
  });

  it('creates ZIP with directory entry', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'mydir/', isDirectory: true }),
      null,
    );
    stream.entry(
      new ZipArchiveEntry({ name: 'mydir/file.txt' }),
      Buffer.from('inside dir'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Should contain both entry names
    expect(buf.includes(Buffer.from('mydir/'))).toBe(true);
    expect(buf.includes(Buffer.from('mydir/file.txt'))).toBe(true);
  });

  it('accepts string source', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'str.txt', store: true }),
      'String content',
    );

    await stream.finalize();
    const buf = await resultPromise;
    expect(buf.includes(Buffer.from('String content'))).toBe(true);
  });

  it('accepts Readable stream source', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const readable = Readable.from([Buffer.from('Stream '), Buffer.from('content')]);
    stream.entry(
      new ZipArchiveEntry({ name: 'stream.txt', store: true }),
      readable,
    );

    await stream.finalize();
    const buf = await resultPromise;
    expect(buf.includes(Buffer.from('Stream '))).toBe(true);
  });

  it('sets UTF-8 flag in headers', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'utf8.txt' }),
      Buffer.from('test'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // General purpose flag at offset 6 in local file header
    const flags = buf.readUInt16LE(6);
    expect(flags & 0x0800).toBe(0x0800); // UTF-8 flag
  });

  it('includes archive comment', async () => {
    const stream = new ZipArchiveOutputStream({ comment: 'Test archive' });
    const resultPromise = collectStream(stream);
    await stream.finalize();
    const buf = await resultPromise;
    expect(buf.includes(Buffer.from('Test archive'))).toBe(true);
  });

  it('creates ZIP with forceZip64', async () => {
    const stream = new ZipArchiveOutputStream({ forceZip64: true });
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'z64.txt', store: true }),
      Buffer.from('zip64 test'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // ZIP64 end of central directory record signature
    let hasZip64Eocd = false;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x06064b50) {
        hasZip64Eocd = true;
        break;
      }
    }
    expect(hasZip64Eocd).toBe(true);
  });

  it('produces a valid ZIP extractable by unzip', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const content1 = 'Hello from arkiv!';
    const content2 = 'Second file content here.\n'.repeat(100);

    stream.entry(
      new ZipArchiveEntry({ name: 'greeting.txt' }),
      Buffer.from(content1),
    );
    stream.entry(
      new ZipArchiveEntry({ name: 'subdir/large.txt' }),
      Buffer.from(content2),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Write to temp file and try to extract with system unzip
    const tmpDir = mkdtempSync(join(tmpdir(), 'arkiv-test-'));
    const zipPath = join(tmpDir, 'test.zip');
    const extractDir = join(tmpDir, 'out');

    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });

      const extracted1 = readFileSync(join(extractDir, 'greeting.txt'), 'utf8');
      expect(extracted1).toBe(content1);

      const extracted2 = readFileSync(join(extractDir, 'subdir', 'large.txt'), 'utf8');
      expect(extracted2).toBe(content2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('compresses data with custom zlib level', async () => {
    const content = 'B'.repeat(10000);

    // Level 1 (fastest)
    const stream1 = new ZipArchiveOutputStream({ zlib: { level: 1 } });
    const result1Promise = collectStream(stream1);
    stream1.entry(new ZipArchiveEntry({ name: 'a.txt' }), Buffer.from(content));
    await stream1.finalize();
    const buf1 = await result1Promise;

    // Level 9 (best compression)
    const stream9 = new ZipArchiveOutputStream({ zlib: { level: 9 } });
    const result9Promise = collectStream(stream9);
    stream9.entry(new ZipArchiveEntry({ name: 'a.txt' }), Buffer.from(content));
    await stream9.finalize();
    const buf9 = await result9Promise;

    // Level 9 should be <= level 1
    expect(buf9.length).toBeLessThanOrEqual(buf1.length);
  });
});
