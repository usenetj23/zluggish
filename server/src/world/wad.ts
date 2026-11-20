import { existsSync, readFileSync } from 'node:fs';

/**
Zwift ships its asset archives as .wad files: one LZ-compressed blob with
an entry table after a 0x2000 preamble. The bundled workout library lives
in workouts.wad, and its XML carries the very ids the client log prints
(legacyIdHash, uniqueId) plus the on-screen textevents, so reading the
archive aloud is reading what the game shows.
*/
export interface WadEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let crc = index;

    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1 ? ((crc >>> 1) ^ 0xed_b8_83_20) >>> 0 : crc >>> 1) >>> 0;

    table[index] = crc >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0;

  for (const byte of bytes) crc = ((crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!) >>> 0;

  return (0xff_ff_ff_ff ^ crc) >>> 0;
}

/** Inflate the LZ stream that follows the header, mirroring the reverse-engineered decoder. */
export function inflate(bytes: Uint8Array, start: number, end: number) {
  const out: number[] = [];
  let cursor = start;

  const literal = (length: number) => {
    for (const byte of bytes.subarray(cursor, cursor + length)) out.push(byte);

    cursor += length;
  };

  const simpleChunk = () => {
    let length = bytes[cursor++]!;

    if (length === 0) {
      length = bytes[cursor]! | (bytes[cursor + 1]! << 8);
      cursor += 2;
    } else {
      length += 2;
    }

    literal(length);
  };

  const backCopy = (length: number, offset: number) => {
    const from = Math.max(0, out.length - offset);

    for (const byte of out.slice(from, from + Math.min(length, offset))) out.push(byte);
  };

  simpleChunk();

  while (cursor < end) {
    const b0 = bytes[cursor]!;
    const b1 = bytes[cursor + 1]!;

    cursor += 2;

    const tag = b0 & 0xe0;
    let literals = 0;

    if (tag < 0xc0) {
      literals = b0 & 3;
      backCopy((b0 >> 5) + 4, b1 | ((b0 & 0xc) << 6));
    } else if (tag === 0xc0) {
      const b2 = bytes[cursor++]!;

      literals = b1 & 3;
      backCopy((b0 & 0x1f) + 4, b2 | ((b1 & 0xfc) << 6));
    } else if (tag === 0xe0) {
      const b2 = bytes[cursor++]!;

      if ((b0 & 0xf) === 0) {
        let length = b1 + 18;

        if (length <= 0x12) {
          const b3 = bytes[cursor]!;
          const b4 = bytes[cursor + 1]!;
          const b5 = bytes[cursor + 2]!;

          cursor += 3;
          literals = b4 & 3;
          length = b3 | (b2 << 8);
          backCopy(length, b5 | (((b4 & 0xfc) | (16 * (b0 & 0x10))) << 6));
        } else {
          const b3 = bytes[cursor++]!;

          literals = b2 & 3;
          backCopy(length, b3 | (((b2 & 0xfc) | (16 * (b0 & 0x10))) << 6));
        }
      } else {
        literals = b1 & 3;
        backCopy((b0 & 0xf) + 3, b2 | (((b1 & 0xfc) | (16 * (b0 & 0x10))) << 6));
      }
    }

    if (literals !== 3 && cursor < end) {
      if (literals > 0) literal(literals);
      else simpleChunk();
    }
  }

  return Uint8Array.from(out);
}

/** Decode a Zwift .wad archive into its entries. */
export function decodeWad(bytes: Uint8Array): WadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0xf0, true);
  const inflated = inflate(bytes, 0x1_00, bytes.length);

  if (crc32(inflated) !== signature) throw new Error('WAD checksum mismatch');

  const entries: WadEntry[] = [];
  let cursor = 0x20_00;

  while (cursor + 4 + 0x60 + 8 + 0x54 <= inflated.length) {
    cursor += 4;

    const name = new TextDecoder()
      .decode(inflated.subarray(cursor, cursor + 0x60))
      .split('\0', 1)[0]!
      .replaceAll('\\', '/');

    cursor += 0x60;

    const size = view.byteLength ? new DataView(inflated.buffer).getUint32(cursor + 4, true) : 0;

    cursor += 8 + 0x54;

    if (cursor + size > inflated.length) break;
    entries.push({ name, data: inflated.subarray(cursor, cursor + size) });
    cursor += size + ((0x40 - (size % 0x40)) % 0x40);
  }

  return entries;
}

/** Read and decode a .wad file from disk; null when the file is missing. */
export function loadWad(path: string): WadEntry[] | null {
  if (!existsSync(path)) return null;

  return decodeWad(new Uint8Array(readFileSync(path)));
}
