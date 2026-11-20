import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWad, inflate } from '#src/world/wad';

const encode = (payload: Uint8Array) => {
  // A literal-only stream is legal: one simple chunk covers the payload.
  const head = payload.length <= 253 ? [payload.length - 2] : [0, payload.length & 0xff, (payload.length >> 8) & 0xff];

  const file = new Uint8Array(0x1_00 + head.length + payload.length);

  new DataView(file.buffer).setUint32(0xf0, crc(payload), true);
  file.set(head, 0x1_00);
  file.set(payload, 0x1_00 + head.length);

  return file;
};

const CRC = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let crc = index;

    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1 ? ((crc >>> 1) ^ 0xed_b8_83_20) >>> 0 : crc >>> 1) >>> 0;

    table[index] = crc >>> 0;
  }

  return table;
})();

function crc(bytes: Uint8Array) {
  let value = 0;

  for (const byte of bytes) value = ((value >>> 8) ^ CRC[(value ^ byte) & 0xff]!) >>> 0;

  return (0xff_ff_ff_ff ^ value) >>> 0;
}

await test('back copies repeat what the window already holds', () => {
  const stream = new Uint8Array([4, ...new TextEncoder().encode('ABCDEF'), 0x40, 6]);

  assert.equal(new TextDecoder().decode(inflate(stream, 0, stream.length)), 'ABCDEFABCDEF');
});

await test('a checksummed literal archive decodes', () => {
  const payload = new Uint8Array(0x20_10); // empty entry region: no entries, but a valid archive
  const entries = decodeWad(encode(payload));

  assert.deepEqual(entries, []);
});

await test('a tampered payload fails the checksum', () => {
  const file = encode(new Uint8Array(0x20_10));

  const last = file.length - 1;

  file[last] = file[last]! ^ 0xff;
  assert.throws(() => decodeWad(file), /checksum/);
});
