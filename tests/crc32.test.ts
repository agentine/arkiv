import { describe, it, expect } from 'vitest';
import { crc32 } from '../src/crc32.js';

describe('crc32', () => {
  it('returns 0 for empty buffer', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('computes correct CRC for "test"', () => {
    // Known CRC32 of "test" is 0xD87F7E0C
    expect(crc32(Buffer.from('test'))).toBe(0xd87f7e0c);
  });

  it('computes correct CRC for "123456789"', () => {
    // Known CRC32 check value: 0xCBF43926
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('computes correct CRC for "Hello, World!"', () => {
    expect(crc32(Buffer.from('Hello, World!'))).toBe(0xec4ac3d0);
  });

  it('computes correct CRC for single byte 0x00', () => {
    expect(crc32(Buffer.from([0x00]))).toBe(0xd202ef8d);
  });

  it('computes correct CRC for all zero bytes', () => {
    expect(crc32(Buffer.alloc(256))).toBe(0x0d968558);
  });

  it('supports incremental computation', () => {
    const full = crc32(Buffer.from('Hello, World!'));
    const partial1 = crc32(Buffer.from('Hello, '));
    const partial2 = crc32(Buffer.from('World!'), partial1);
    expect(partial2).toBe(full);
  });

  it('works with Uint8Array', () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(crc32(data)).toBe(crc32(Buffer.from('Hello')));
  });

  it('handles large data', () => {
    const buf = Buffer.alloc(1024 * 1024, 0x42); // 1MB of 'B'
    const result = crc32(buf);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });
});
