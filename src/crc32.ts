// CRC32 — table-based implementation (IEEE polynomial 0xEDB88320)

const TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer | Uint8Array, prev = 0): number {
  let crc = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
