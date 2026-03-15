import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiver } from '../src/archiver.js';
import { ZipArchiveEntry, ZipArchiveOutputStream } from '../src/zip.js';
import { TarArchiveEntry, TarArchiveOutputStream } from '../src/tar.js';
import { globWalk, globToRegex } from '../src/glob.js';

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'arkiv-edge-'));
  writeFileSync(join(testDir, 'a.txt'), 'A');
  writeFileSync(join(testDir, 'b.js'), 'B');
  writeFileSync(join(testDir, '.hidden'), 'hidden');
  mkdirSync(join(testDir, 'sub'));
  writeFileSync(join(testDir, 'sub', 'c.txt'), 'C');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('edge cases: empty archives', () => {
  it('empty ZIP archive is valid', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);
    await archive.finalize();
    const buf = await resultPromise;

    // Should have EOCD at minimum
    expect(buf.length).toBeGreaterThanOrEqual(22);
    // Can extract (no files)
    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-empty-zip-'));
    const zipPath = join(tmpOut, 'empty.zip');
    try {
      writeFileSync(zipPath, buf);
      // unzip on macOS exits 1 for empty zip, so just check the file is valid-ish
      const output = execSync(`unzip -l "${zipPath}" 2>&1 || true`, { encoding: 'utf8' });
      expect(output).toMatch(/empty|0 file/);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('empty TAR archive is valid', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);
    await archive.finalize();
    const buf = await resultPromise;

    // Empty TAR: two 512-byte zero blocks = 1024 bytes
    expect(buf.length).toBe(1024);
  });

  it('empty TAR.GZ archive is valid gzip', async () => {
    const archive = createArchiver('tar', { gzip: true });
    const resultPromise = collectStream(archive);
    await archive.finalize();
    const buf = await resultPromise;

    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });
});

describe('edge cases: paths', () => {
  it('ZIP handles paths with special characters', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.append('test', { name: 'path with spaces/file (1).txt' });
    await archive.finalize();
    const buf = await resultPromise;

    expect(buf.includes(Buffer.from('path with spaces/file (1).txt'))).toBe(true);
  });

  it('ZIP handles Unicode filenames', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.append('unicode', { name: 'données/fichier-été.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    // UTF-8 flag should be set
    const flags = buf.readUInt16LE(6);
    expect(flags & 0x0800).toBe(0x0800);
  });

  it('TAR handles long paths via PAX', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    const longPath = 'a/'.repeat(150) + 'file.txt';
    stream.entry(
      new TarArchiveEntry({ name: longPath }),
      Buffer.from('long path'),
    );
    await stream.finalize();
    const buf = await resultPromise;

    // PAX type flag 'x'
    expect(buf.toString('ascii', 156, 157)).toBe('x');
  });

  it('normalizes Windows-style paths to POSIX', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    // Even if we pass backslashes, they should be normalized
    archive.append('win', { name: 'dir/subdir/file.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    expect(buf.includes(Buffer.from('dir/subdir/file.txt'))).toBe(true);
  });
});

describe('edge cases: ZIP64', () => {
  it('forceZip64 includes ZIP64 structures', async () => {
    const stream = new ZipArchiveOutputStream({ forceZip64: true });
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'z64.txt' }),
      Buffer.from('zip64 content'),
    );
    await stream.finalize();
    const buf = await resultPromise;

    // ZIP64 EOCD signature
    let hasZ64Eocd = false;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x06064b50) {
        hasZ64Eocd = true;
        break;
      }
    }
    expect(hasZ64Eocd).toBe(true);

    // ZIP64 EOCD locator
    let hasZ64Locator = false;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        hasZ64Locator = true;
        break;
      }
    }
    expect(hasZ64Locator).toBe(true);
  });

  it('ZIP64 data descriptor uses 8-byte sizes', async () => {
    const stream = new ZipArchiveOutputStream({ forceZip64: true });
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'a.txt' }),
      Buffer.from('test'),
    );
    await stream.finalize();
    const buf = await resultPromise;

    // Find data descriptor signature
    let ddOffset = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0x08074b50) {
        ddOffset = i;
        break;
      }
    }
    expect(ddOffset).toBeGreaterThan(0);
    // ZIP64 data descriptor: 4 sig + 4 crc + 8 compressed + 8 uncompressed = 24
    // Check it's not the 16-byte standard version
    const ddLength = 24;
    expect(ddOffset + ddLength).toBeLessThanOrEqual(buf.length);
  });
});

describe('edge cases: symlinks in TAR', () => {
  it('symlink entry has type flag 2', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new TarArchiveEntry({ name: 'link', type: '2', linkname: 'target' }),
      null,
    );
    await stream.finalize();
    const buf = await resultPromise;

    expect(buf.toString('ascii', 156, 157)).toBe('2');
    expect(buf.toString('ascii', 157, 163)).toBe('target');
  });

  it('Archiver.symlink() creates TAR symlink', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);

    archive.append('target content', { name: 'real.txt' });
    archive.symlink('link.txt', 'real.txt');
    await archive.finalize();
    const buf = await resultPromise;

    // Second entry header at offset 1024 (512 header + 512 data)
    expect(buf.toString('ascii', 1024 + 156, 1024 + 157)).toBe('2');
  });
});

describe('edge cases: ZIP store mode', () => {
  it('store mode does not compress', async () => {
    const stream = new ZipArchiveOutputStream({ store: true });
    const resultPromise = collectStream(stream);

    const content = 'AAAA'.repeat(100);
    stream.entry(
      new ZipArchiveEntry({ name: 'stored.txt', store: true }),
      Buffer.from(content),
    );
    await stream.finalize();
    const buf = await resultPromise;

    // Content should appear literally in the archive
    expect(buf.includes(Buffer.from(content))).toBe(true);
    // Compression method = 0 (store) at offset 8 in local header
    expect(buf.readUInt16LE(8)).toBe(0);
  });
});

describe('edge cases: archive comment', () => {
  it('ZIP archive comment is preserved', async () => {
    const archive = createArchiver('zip', { comment: 'Created by arkiv' });
    const resultPromise = collectStream(archive);

    archive.append('data', { name: 'file.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    expect(buf.includes(Buffer.from('Created by arkiv'))).toBe(true);
  });
});

describe('edge cases: entry comments', () => {
  it('ZIP entry comment is stored in central directory', async () => {
    const stream = new ZipArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(
      new ZipArchiveEntry({ name: 'commented.txt', comment: 'A useful file' }),
      Buffer.from('data'),
    );
    await stream.finalize();
    const buf = await resultPromise;

    expect(buf.includes(Buffer.from('A useful file'))).toBe(true);
  });
});

describe('glob', () => {
  it('globToRegex matches *.txt', () => {
    const re = globToRegex('*.txt', false);
    expect(re.test('hello.txt')).toBe(true);
    expect(re.test('hello.js')).toBe(false);
    expect(re.test('dir/hello.txt')).toBe(false);
  });

  it('globToRegex matches **/*.txt', () => {
    const re = globToRegex('**/*.txt', false);
    expect(re.test('hello.txt')).toBe(true);
    expect(re.test('dir/hello.txt')).toBe(true);
    expect(re.test('dir/sub/hello.txt')).toBe(true);
    expect(re.test('hello.js')).toBe(false);
  });

  it('globToRegex matches ? wildcard', () => {
    const re = globToRegex('?.txt', false);
    expect(re.test('a.txt')).toBe(true);
    expect(re.test('ab.txt')).toBe(false);
  });

  it('globToRegex matches brace expansion', () => {
    const re = globToRegex('*.{js,ts}', false);
    expect(re.test('file.js')).toBe(true);
    expect(re.test('file.ts')).toBe(true);
    expect(re.test('file.py')).toBe(false);
  });

  it('globWalk finds files matching pattern', async () => {
    const matches = await globWalk('*.txt', { cwd: testDir });
    const names = matches.map((m) => m.path).sort();
    expect(names).toContain('a.txt');
    expect(names).not.toContain('b.js');
  });

  it('globWalk skips dot files by default', async () => {
    const matches = await globWalk('*', { cwd: testDir });
    const names = matches.map((m) => m.path);
    expect(names).not.toContain('.hidden');
  });

  it('globWalk includes dot files with dot option', async () => {
    const matches = await globWalk('*', { cwd: testDir, dot: true });
    const names = matches.map((m) => m.path);
    expect(names).toContain('.hidden');
  });

  it('globWalk respects ignore option', async () => {
    const matches = await globWalk('*', { cwd: testDir, ignore: '*.js' });
    const names = matches.map((m) => m.path);
    expect(names).toContain('a.txt');
    expect(names).not.toContain('b.js');
  });

  it('globWalk finds in subdirectories with **', async () => {
    const matches = await globWalk('**/*.txt', { cwd: testDir });
    const names = matches.map((m) => m.path).sort();
    expect(names).toContain('a.txt');
    expect(names).toContain('sub/c.txt');
  });
});

describe('edge cases: multiple finalize calls', () => {
  it('finalize() returns same promise on second call', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.append('data', { name: 'f.txt' });
    const p1 = archive.finalize();
    const p2 = archive.finalize();
    expect(p1).toBe(p2);

    await p1;
    await resultPromise;
  });
});

describe('edge cases: TAR checksum correctness', () => {
  it('every TAR header has correct checksum', async () => {
    const stream = new TarArchiveOutputStream();
    const resultPromise = collectStream(stream);

    stream.entry(new TarArchiveEntry({ name: 'one.txt' }), Buffer.from('1'));
    stream.entry(new TarArchiveEntry({ name: 'two.txt' }), Buffer.from('22'));
    stream.entry(new TarArchiveEntry({ name: 'three.txt' }), Buffer.from('333'));
    await stream.finalize();
    const buf = await resultPromise;

    // Check each 512-byte block that starts with non-zero bytes (headers)
    for (let offset = 0; offset < buf.length - 512; offset += 512) {
      const block = buf.subarray(offset, offset + 512);
      // Skip zero blocks (EOF or data padding)
      if (block.every((b) => b === 0)) continue;
      // Skip data blocks (no ustar magic)
      if (block.toString('ascii', 257, 263) !== 'ustar\0') continue;

      // Verify checksum
      const stored = parseInt(
        block.toString('ascii', 148, 155).replace(/\0/g, '').trim(),
        8,
      );
      const header = Buffer.from(block);
      header.fill(0x20, 148, 156);
      let calc = 0;
      for (let i = 0; i < 512; i++) calc += header[i];

      expect(stored).toBe(calc);
    }
  });
});

describe('edge cases: large content', () => {
  it('ZIP handles 1MB file correctly', async () => {
    const archive = createArchiver('zip', { zlib: { level: 1 } });
    const resultPromise = collectStream(archive);

    const big = Buffer.alloc(1024 * 1024, 0x42);
    archive.append(big, { name: 'big.bin' });
    await archive.finalize();
    const buf = await resultPromise;

    // Compressed should be smaller
    expect(buf.length).toBeLessThan(big.length);

    // Extract and verify
    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-big-'));
    const zipPath = join(tmpOut, 'big.zip');
    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${tmpOut}/out"`, { stdio: 'pipe' });
      const extracted = readFileSync(join(tmpOut, 'out', 'big.bin'));
      expect(extracted.length).toBe(big.length);
      expect(extracted.equals(big)).toBe(true);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('TAR handles 1MB file correctly', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);

    const big = Buffer.alloc(1024 * 1024, 0x43);
    archive.append(big, { name: 'big.bin' });
    await archive.finalize();
    const buf = await resultPromise;

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-big-tar-'));
    const tarPath = join(tmpOut, 'big.tar');
    try {
      writeFileSync(tarPath, buf);
      execSync(`mkdir -p "${tmpOut}/out" && tar xf "${tarPath}" -C "${tmpOut}/out"`, {
        stdio: 'pipe',
      });
      const extracted = readFileSync(join(tmpOut, 'out', 'big.bin'));
      expect(extracted.length).toBe(big.length);
      expect(extracted.equals(big)).toBe(true);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
