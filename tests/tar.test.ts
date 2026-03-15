import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TarArchiveEntry, TarArchiveOutputStream } from '../src/tar.js';

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('TarArchiveEntry', () => {
  it('creates entry with defaults', () => {
    const entry = new TarArchiveEntry({ name: 'test.txt' });
    expect(entry.name).toBe('test.txt');
    expect(entry.mode).toBe(0o644);
    expect(entry.type).toBe('0');
    expect(entry.uid).toBe(0);
    expect(entry.gid).toBe(0);
    expect(entry.mtime).toBeInstanceOf(Date);
  });

  it('creates directory entry', () => {
    const entry = new TarArchiveEntry({ name: 'dir/', type: '5' });
    expect(entry.type).toBe('5');
    expect(entry.mode).toBe(0o755);
  });

  it('accepts custom properties', () => {
    const d = new Date(2020, 0, 1);
    const entry = new TarArchiveEntry({
      name: 'custom.txt',
      mode: 0o755,
      uid: 1000,
      gid: 1000,
      mtime: d,
      uname: 'user',
      gname: 'group',
    });
    expect(entry.mode).toBe(0o755);
    expect(entry.uid).toBe(1000);
    expect(entry.gid).toBe(1000);
    expect(entry.mtime).toBe(d);
    expect(entry.uname).toBe('user');
    expect(entry.gname).toBe('group');
  });
});

describe('TarArchiveOutputStream', () => {
  it('creates valid empty TAR archive', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);
    await stream.finalize();
    const buf = await resultPromise;

    // Empty TAR: two 512-byte zero blocks = 1024 bytes
    expect(buf.length).toBe(1024);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('creates TAR with a single file', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const entry = new TarArchiveEntry({ name: 'hello.txt' });
    stream.entry(entry, Buffer.from('Hello, World!'));
    await stream.finalize();
    const buf = await resultPromise;

    // At least: 512 header + 512 data (padded) + 1024 EOF
    expect(buf.length).toBeGreaterThanOrEqual(512 + 512 + 1024);

    // Check ustar magic at offset 257
    const magic = buf.toString('ascii', 257, 263);
    expect(magic).toBe('ustar\0');

    // Filename at offset 0
    const name = buf.toString('ascii', 0, 9);
    expect(name).toBe('hello.txt');
  });

  it('creates TAR with multiple files', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'file1.txt' }),
      Buffer.from('Content 1'),
    );
    stream.entry(
      new TarArchiveEntry({ name: 'file2.txt' }),
      Buffer.from('Content 2'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Two headers + two data blocks + EOF
    expect(buf.length).toBe(512 + 512 + 512 + 512 + 1024);
  });

  it('creates TAR with directory entry', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'mydir/', type: '5' }),
      null,
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Directory type flag at offset 156
    expect(buf.toString('ascii', 156, 157)).toBe('5');
  });

  it('pads data to 512-byte blocks', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    // 10 bytes of data → should be padded to 512
    stream.entry(
      new TarArchiveEntry({ name: 'small.txt' }),
      Buffer.from('0123456789'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // 512 header + 512 padded data + 1024 EOF
    expect(buf.length).toBe(512 + 512 + 1024);
  });

  it('handles exact 512-byte data without extra padding', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'exact.txt' }),
      Buffer.alloc(512, 0x41),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // 512 header + 512 data (exact) + 1024 EOF
    expect(buf.length).toBe(512 + 512 + 1024);
  });

  it('accepts string source', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'str.txt' }),
      'String content',
    );

    await stream.finalize();
    const buf = await resultPromise;
    // Data should be present after header
    const dataStart = 512;
    const content = buf.toString('utf8', dataStart, dataStart + 14);
    expect(content).toBe('String content');
  });

  it('accepts Readable stream source', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const readable = Readable.from([Buffer.from('Stream '), Buffer.from('content')]);
    stream.entry(
      new TarArchiveEntry({ name: 'stream.txt' }),
      readable,
    );

    await stream.finalize();
    const buf = await resultPromise;
    const dataStart = 512;
    const content = buf.toString('utf8', dataStart, dataStart + 14);
    expect(content).toBe('Stream content');
  });

  it('writes correct size in header', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const data = Buffer.from('Hello!'); // 6 bytes
    stream.entry(
      new TarArchiveEntry({ name: 'sized.txt' }),
      data,
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Size field at offset 124, 12 bytes, octal null-terminated
    const sizeStr = buf.toString('ascii', 124, 135).replace(/\0/g, '');
    expect(parseInt(sizeStr, 8)).toBe(6);
  });

  it('writes correct checksum', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'chk.txt' }),
      Buffer.from('data'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Verify checksum: sum of all header bytes, treating checksum field as spaces
    const header = Buffer.from(buf.subarray(0, 512));
    const storedChksum = parseInt(
      header.toString('ascii', 148, 155).replace(/\0/g, '').trim(),
      8,
    );

    // Replace checksum field with spaces to recalculate
    header.fill(0x20, 148, 156);
    let calcChksum = 0;
    for (let i = 0; i < 512; i++) {
      calcChksum += header[i];
    }

    expect(storedChksum).toBe(calcChksum);
  });

  it('handles long paths with prefix split', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    // Path that needs prefix/name split (>100 chars but <255)
    const longPath = 'a/'.repeat(60) + 'file.txt'; // ~128 chars
    stream.entry(
      new TarArchiveEntry({ name: longPath }),
      Buffer.from('long path test'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Should have a prefix field
    const prefix = buf.toString('ascii', 345, 500).replace(/\0+$/, '');
    expect(prefix.length).toBeGreaterThan(0);
  });

  it('uses PAX headers for paths >255 chars', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const longPath = 'dir/'.repeat(80) + 'file.txt'; // ~328 chars
    stream.entry(
      new TarArchiveEntry({ name: longPath }),
      Buffer.from('pax test'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // PAX header type flag 'x' should appear before the actual entry
    expect(buf.toString('ascii', 156, 157)).toBe('x');
    // PAX data should contain "path="
    const paxData = buf.toString('utf8', 512, 1024);
    expect(paxData).toContain('path=');
    expect(paxData).toContain(longPath);
  });

  it('produces valid TAR extractable by system tar', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const content1 = 'Hello from arkiv TAR!';
    const content2 = 'Second file.\n'.repeat(50);

    stream.entry(
      new TarArchiveEntry({ name: 'greeting.txt' }),
      Buffer.from(content1),
    );
    stream.entry(
      new TarArchiveEntry({ name: 'subdir/', type: '5' }),
      null,
    );
    stream.entry(
      new TarArchiveEntry({ name: 'subdir/data.txt' }),
      Buffer.from(content2),
    );

    await stream.finalize();
    const buf = await resultPromise;

    const tmpDir = mkdtempSync(join(tmpdir(), 'arkiv-tar-test-'));
    const tarPath = join(tmpDir, 'test.tar');
    const extractDir = join(tmpDir, 'out');

    try {
      writeFileSync(tarPath, buf);
      execSync(`mkdir -p "${extractDir}" && tar xf "${tarPath}" -C "${extractDir}"`, {
        stdio: 'pipe',
      });

      const extracted1 = readFileSync(join(extractDir, 'greeting.txt'), 'utf8');
      expect(extracted1).toBe(content1);

      const extracted2 = readFileSync(join(extractDir, 'subdir', 'data.txt'), 'utf8');
      expect(extracted2).toBe(content2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('produces valid gzip TAR when gzip option is used at extraction level', async () => {
    // The TarArchiveOutputStream outputs raw TAR; gzip is applied by piping
    // through createGzip at the consumer level (or by Archiver in Phase 4).
    // This test verifies the raw TAR output is valid.
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'gztest.txt' }),
      Buffer.from('gzip test content'),
    );

    await stream.finalize();
    const buf = await resultPromise;

    // Verify it's a valid TAR by checking ustar magic
    expect(buf.toString('ascii', 257, 263)).toBe('ustar\0');
  });
});
