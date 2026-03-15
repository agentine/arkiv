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
import archiver, { Archiver, createArchiver } from '../src/compat/archiver.js';

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
  testDir = mkdtempSync(join(tmpdir(), 'arkiv-compat-test-'));
  writeFileSync(join(testDir, 'hello.txt'), 'Hello from compat test');
  mkdirSync(join(testDir, 'data'));
  writeFileSync(join(testDir, 'data', 'info.txt'), 'Info file content');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('compat/archiver', () => {
  it('default export is a factory function', () => {
    expect(typeof archiver).toBe('function');
  });

  it('archiver() returns Archiver instance', () => {
    const archive = archiver('zip');
    expect(archive).toBeInstanceOf(Archiver);
  });

  it('archiver.create() is an alias', () => {
    const archive = archiver.create('tar');
    expect(archive).toBeInstanceOf(Archiver);
  });

  it('archiver.isRegisteredFormat() returns true for zip/tar', () => {
    expect(archiver.isRegisteredFormat('zip')).toBe(true);
    expect(archiver.isRegisteredFormat('tar')).toBe(true);
    expect(archiver.isRegisteredFormat('rar')).toBe(false);
  });

  it('archiver.registerFormat() is a no-op', () => {
    expect(() => archiver.registerFormat('custom', {})).not.toThrow();
  });

  it('works as drop-in: ZIP append + pipe + finalize', async () => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const resultPromise = collectStream(archive);

    archive.append(Buffer.from('Drop-in test'), { name: 'dropin.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-compat-zip-'));
    const zipPath = join(tmpOut, 'test.zip');
    try {
      writeFileSync(zipPath, buf);
      execSync(`unzip -o "${zipPath}" -d "${tmpOut}/out"`, { stdio: 'pipe' });
      expect(readFileSync(join(tmpOut, 'out', 'dropin.txt'), 'utf8')).toBe('Drop-in test');
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('works as drop-in: TAR with file()', async () => {
    const archive = archiver('tar');
    const resultPromise = collectStream(archive);

    archive.file(join(testDir, 'hello.txt'), { name: 'hello.txt' });
    await archive.finalize();
    const buf = await resultPromise;

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-compat-tar-'));
    const tarPath = join(tmpOut, 'test.tar');
    try {
      writeFileSync(tarPath, buf);
      execSync(`mkdir -p "${tmpOut}/out" && tar xf "${tarPath}" -C "${tmpOut}/out"`, {
        stdio: 'pipe',
      });
      expect(readFileSync(join(tmpOut, 'out', 'hello.txt'), 'utf8')).toBe(
        'Hello from compat test',
      );
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('works as drop-in: TAR.GZ with directory()', async () => {
    const archive = archiver('tar', { gzip: true });
    const resultPromise = collectStream(archive);

    archive.directory(join(testDir, 'data'), 'data');
    await archive.finalize();
    const buf = await resultPromise;

    // Gzip magic
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);

    const tmpOut = mkdtempSync(join(tmpdir(), 'arkiv-compat-tgz-'));
    const tgzPath = join(tmpOut, 'test.tar.gz');
    try {
      writeFileSync(tgzPath, buf);
      execSync(`mkdir -p "${tmpOut}/out" && tar xzf "${tgzPath}" -C "${tmpOut}/out"`, {
        stdio: 'pipe',
      });
      expect(readFileSync(join(tmpOut, 'out', 'data', 'info.txt'), 'utf8')).toBe(
        'Info file content',
      );
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it('exports createArchiver for named import', () => {
    expect(typeof createArchiver).toBe('function');
    const archive = createArchiver('zip');
    expect(archive).toBeInstanceOf(Archiver);
  });
});
