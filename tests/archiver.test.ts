import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiver, Archiver } from '../src/archiver.js';

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Create a temp directory with test files
let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'arkiv-archiver-test-'));
  writeFileSync(join(testDir, 'a.txt'), 'file A content');
  writeFileSync(join(testDir, 'b.txt'), 'file B content');
  mkdirSync(join(testDir, 'sub'));
  writeFileSync(join(testDir, 'sub', 'c.txt'), 'file C in subdir');
  writeFileSync(join(testDir, 'sub', 'd.txt'), 'file D in subdir');
  mkdirSync(join(testDir, 'sub', 'nested'));
  writeFileSync(join(testDir, 'sub', 'nested', 'e.txt'), 'nested file E');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('Archiver', () => {
  it('creates ZIP archive with append()', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.append(Buffer.from('Hello'), { name: 'hello.txt' });
    archive.append('World', { name: 'world.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    // Valid ZIP
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.includes(Buffer.from('hello.txt'))).toBe(true);
    expect(buf.includes(Buffer.from('world.txt'))).toBe(true);
  });

  it('creates TAR archive with append()', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);

    archive.append(Buffer.from('Hello'), { name: 'hello.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    // Valid TAR ustar magic
    expect(buf.toString('ascii', 257, 263)).toBe('ustar\0');
  });

  it('creates gzipped TAR with gzip option', async () => {
    const archive = createArchiver('tar', { gzip: true });
    const resultPromise = collectStream(archive);

    archive.append(Buffer.from('Compressed content'), { name: 'data.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    // Gzip magic bytes
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it('file() reads from filesystem', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.file(join(testDir, 'a.txt'), { name: 'a.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    // Extract and verify
    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-file-test-'));
    const zipPath = join(tmpOut, 'test.zip');
    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${tmpOut}/out"`, { stdio: 'pipe' });
      const content = readFileSync(join(tmpOut, 'out', 'a.txt'), 'utf8');
      expect(content).toBe('file A content');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('directory() adds directory recursively', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);

    archive.directory(join(testDir, 'sub'), 'mydir');
    await archive.finalize();
    const buf = await resultPromise;

    // Extract and verify
    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-dir-test-'));
    const tarPath = join(tmpOut, 'test.tar');
    try {
      writeFileSync(tarPath, buf);
      execSync(`mkdir -p "${tmpOut}/out" && tar xf "${tarPath}" -C "${tmpOut}/out"`, {
        stdio: 'pipe',
      });
      const content = readFileSync(join(tmpOut, 'out', 'mydir', 'c.txt'), 'utf8');
      expect(content).toBe('file C in subdir');

      const nested = readFileSync(join(tmpOut, 'out', 'mydir', 'nested', 'e.txt'), 'utf8');
      expect(nested).toBe('nested file E');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('pointer() tracks bytes written', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    expect(archive.pointer()).toBe(0);
    archive.append(Buffer.from('data'), { name: 'file.txt' });
    await archive.finalize();
    await resultPromise;

    expect(archive.pointer()).toBeGreaterThan(0);
  });

  it('progress() tracks entries', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.append('one', { name: '1.txt' });
    archive.append('two', { name: '2.txt' });
    await archive.finalize();
    await resultPromise;

    const p = archive.progress();
    expect(p.entries.total).toBe(2);
    expect(p.entries.processed).toBe(2);
  });

  it('emits entry events', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);
    const entries: unknown[] = [];

    archive.on('entry', (data) => entries.push(data));

    archive.append('a', { name: 'a.txt' });
    archive.append('b', { name: 'b.txt' });
    await archive.finalize();
    await resultPromise;

    expect(entries.length).toBe(2);
  });

  it('emits progress events', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);
    const progressEvents: unknown[] = [];

    archive.on('progress', (data) => progressEvents.push(data));

    archive.append('x', { name: 'x.txt' });
    await archive.finalize();
    await resultPromise;

    expect(progressEvents.length).toBeGreaterThan(0);
  });

  it('finalize() rejects after abort()', async () => {
    const archive = createArchiver('zip');
    archive.abort();

    expect(() => archive.append('x', { name: 'x.txt' })).toThrow('Archive aborted');
  });

  it('throws on append after finalize', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);
    archive.finalize();

    expect(() => archive.append('x', { name: 'x.txt' })).toThrow('Archive already finalized');
    await resultPromise.catch(() => {});
  });

  it('accepts Readable stream via append()', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    const readable = Readable.from([Buffer.from('streamed data')]);
    archive.append(readable, { name: 'stream.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    expect(buf.includes(Buffer.from('stream.txt'))).toBe(true);
  });

  it('glob() adds matching files', async () => {
    const archive = createArchiver('zip');
    const resultPromise = collectStream(archive);

    archive.glob('*.txt', { cwd: testDir });
    await archive.finalize();
    const buf = await resultPromise;

    // Extract and check
    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-glob-test-'));
    const zipPath = join(tmpOut, 'test.zip');
    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${tmpOut}/out"`, { stdio: 'pipe' });
      expect(readFileSync(join(tmpOut, 'out', 'a.txt'), 'utf8')).toBe('file A content');
      expect(readFileSync(join(tmpOut, 'out', 'b.txt'), 'utf8')).toBe('file B content');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('creates valid ZIP extractable by unzip with mixed sources', async () => {
    const archive = createArchiver('zip', { zlib: { level: 9 } });
    const resultPromise = collectStream(archive);

    archive.append('inline content', { name: 'inline.txt' });
    archive.file(join(testDir, 'a.txt'), { name: 'from-file.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-mixed-test-'));
    const zipPath = join(tmpOut, 'test.zip');
    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${tmpOut}/out"`, { stdio: 'pipe' });
      expect(readFileSync(join(tmpOut, 'out', 'inline.txt'), 'utf8')).toBe('inline content');
      expect(readFileSync(join(tmpOut, 'out', 'from-file.txt'), 'utf8')).toBe('file A content');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('creates valid TAR.GZ extractable by tar', async () => {
    const archive = createArchiver('tar', { gzip: true });
    const resultPromise = collectStream(archive);

    archive.append('gzip tar content', { name: 'data.txt' });
    archive.file(join(testDir, 'b.txt'), { name: 'b.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-tgz-test-'));
    const tgzPath = join(tmpOut, 'test.tar.gz');
    try {
      writeFileSync(tgzPath, buf);
      execSync(`mkdir -p "${tmpOut}/out" && tar xzf "${tgzPath}" -C "${tmpOut}/out"`, {
        stdio: 'pipe',
      });
      expect(readFileSync(join(tmpOut, 'out', 'data.txt'), 'utf8')).toBe('gzip tar content');
      expect(readFileSync(join(tmpOut, 'out', 'b.txt'), 'utf8')).toBe('file B content');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('symlink() creates symlink entry in TAR', async () => {
    const archive = createArchiver('tar');
    const resultPromise = collectStream(archive);

    archive.append('target content', { name: 'target.txt' });
    archive.symlink('link.txt', 'target.txt');
    await archive.finalize();
    const buf = await resultPromise;

    // The symlink type flag '2' should be in the second header
    // Second header starts at 512 (header) + 512 (data padded)
    const secondHeaderOffset = 1024;
    const typeFlag = buf.toString('ascii', secondHeaderOffset + 156, secondHeaderOffset + 157);
    expect(typeFlag).toBe('2');
  });

  it('setFormat returns this for chaining', () => {
    const archive = createArchiver('zip');
    const result = archive.setFormat('tar');
    expect(result).toBe(archive);
  });

  it('setModule returns this for chaining', () => {
    const archive = createArchiver('zip');
    const result = archive.setModule({});
    expect(result).toBe(archive);
  });
});
