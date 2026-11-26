import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { defaultZipLimits, readZip, ZipError } from '#src/world/zip-reader';

interface ZipFile {
  name: string;
  data: Buffer;
  method?: 0 | 8;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }

  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff;

  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }

  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

interface BuiltZip {
  buffer: Buffer;
  centralAt(name: string): number;
  localAt(name: string): number;
}

function buildZip(files: Array<ZipFile>, options?: { zip64?: boolean }): BuiltZip {
  const locals: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  const localOffsets = new Map<string, number>();
  const centralOffsets = new Map<string, number>();
  let localSize = 0;
  let centralSize = 0;

  for (const file of files) {
    const method = file.method ?? 0;
    const packed = method === 8 ? deflateRawSync(file.data) : file.data;
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const localHeaderOffset = localSize;

    localOffsets.set(file.name, localHeaderOffset);
    locals.push(local, nameBytes, packed);
    localSize += local.length + nameBytes.length + packed.length;

    const entry = Buffer.alloc(46);

    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12); // time
    entry.writeUInt16LE(0, 14); // date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(localHeaderOffset, 42);

    centralOffsets.set(file.name, centralSize);
    central.push(entry, nameBytes);
    centralSize += entry.length + nameBytes.length;
  }

  const centralAt = (name: string): number => {
    const offset = centralOffsets.get(name);

    if (offset === undefined) {
      throw new Error(`no central directory entry for ${name}`);
    }

    return localSize + offset;
  };

  const localAt = (name: string): number => {
    const offset = localOffsets.get(name);

    if (offset === undefined) {
      throw new Error(`no local header for ${name}`);
    }

    return offset;
  };

  const tail: Array<Buffer> = [];

  if (options?.zip64 === true) {
    const zip64 = Buffer.alloc(56);

    zip64.writeUInt32LE(0x06_06_4b_50, 0);
    zip64.writeBigUInt64LE(44n, 4); // size of the record minus 12
    zip64.writeUInt16LE(20, 12); // version made by
    zip64.writeUInt16LE(20, 14); // version needed
    zip64.writeUInt32LE(0, 16); // disk number
    zip64.writeUInt32LE(0, 20); // disk with the central directory
    zip64.writeBigUInt64LE(BigInt(files.length), 24);
    zip64.writeBigUInt64LE(BigInt(files.length), 32);
    zip64.writeBigUInt64LE(BigInt(centralSize), 40);
    zip64.writeBigUInt64LE(BigInt(localSize), 48);

    const locator = Buffer.alloc(20);

    locator.writeUInt32LE(0x07_06_4b_50, 0);
    locator.writeUInt32LE(0, 4); // disk with the zip64 end of central directory
    locator.writeBigUInt64LE(BigInt(localSize + centralSize), 8);
    locator.writeUInt32LE(1, 16); // total number of disks

    tail.push(zip64, locator);
  }

  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(options?.zip64 === true ? 0xff_ff : files.length, 8);
  eocd.writeUInt16LE(options?.zip64 === true ? 0xff_ff : files.length, 10);
  eocd.writeUInt32LE(options?.zip64 === true ? 0xff_ff_ff_ff : centralSize, 12);
  eocd.writeUInt32LE(options?.zip64 === true ? 0xff_ff_ff_ff : localSize, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  tail.push(eocd);

  return { buffer: Buffer.concat([...locals, ...central, ...tail]), centralAt, localAt };
}

function makeZip(files: Array<ZipFile>, options?: { zip64?: boolean }): Buffer {
  return buildZip(files, options).buffer;
}

function expectZipError(run: () => void, message: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ZipError);
    assert.match(error.message, message);

    return true;
  });
}

await test('stored and deflated entries round trip in central directory order', { timeout: 10_000 }, () => {
  const plain = Buffer.from('stored payload', 'utf8');
  const deflated = Buffer.from('deflated payload, compressed with deflate-raw'.repeat(3), 'utf8');
  const entries = readZip(
    makeZip([
      { name: 'a.txt', data: plain },
      { name: 'b/c.txt', data: deflated, method: 8 },
    ]),
  );

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['a.txt', 'b/c.txt'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.size),
    [plain.length, deflated.length],
  );
  assert.deepEqual([...(entries[0]?.data ?? Buffer.alloc(0))], [...plain]);
  assert.deepEqual([...(entries[1]?.data ?? Buffer.alloc(0))], [...deflated]);
});

await test('directory entries are skipped', { timeout: 10_000 }, () => {
  const entries = readZip(
    makeZip([
      { name: 'pages/', data: Buffer.alloc(0) },
      { name: 'pages/one.txt', data: Buffer.from('1', 'utf8') },
    ]),
  );

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['pages/one.txt'],
  );
});

await test('unsafe names are rejected', { timeout: 10_000 }, () => {
  for (const name of ['../evil', 'a/../../b', '/abs', String.raw`a\b`, 'C:/x', '']) {
    expectZipError(() => readZip(makeZip([{ name, data: Buffer.from('x', 'utf8') }])), /unsafe path/);
  }
});

await test('random bytes and an empty buffer are not zip files', { timeout: 10_000 }, () => {
  const noise = Buffer.from(Array.from({ length: 300 }, (_unused, index) => (index * 7 + 13) % 251));

  expectZipError(() => readZip(noise), /not a zip file/);
  expectZipError(() => readZip(Buffer.alloc(0)), /not a zip file/);
});

await test('a truncated archive is rejected instead of crashing', { timeout: 10_000 }, () => {
  const valid = makeZip([{ name: 'a.txt', data: Buffer.from('hello world', 'utf8') }]);

  assert.throws(
    () => readZip(valid.subarray(0, -30)),
    (error: unknown) => error instanceof ZipError,
  );
});

await test('limits reject too many entries, oversized entries and oversized archives', { timeout: 10_000 }, () => {
  const two = makeZip([
    { name: 'a.txt', data: Buffer.from('aaaaaaaaaa', 'utf8') },
    { name: 'b.txt', data: Buffer.from('bbbbbbbbbb', 'utf8') },
  ]);

  expectZipError(() => readZip(two, { ...defaultZipLimits, maxEntries: 1 }), /too many entries/);
  expectZipError(
    () =>
      readZip(makeZip([{ name: 'big.txt', data: Buffer.from('12345678901', 'utf8') }]), {
        ...defaultZipLimits,
        maxEntryBytes: 10,
      }),
    /entry too large/,
  );
  expectZipError(() => readZip(two, { ...defaultZipLimits, maxTotalBytes: 15 }), /archive too large/);
});

await test('a deflate bomb is rejected without inflating it', { timeout: 10_000 }, () => {
  const bomb = makeZip([{ name: 'bomb.bin', data: Buffer.alloc(5 * 1024 * 1024), method: 8 }]);

  assert.ok(bomb.length < 100 * 1024, 'the bomb must stay small');
  expectZipError(() => readZip(bomb, { ...defaultZipLimits, maxEntryBytes: 1024 * 1024 }), /entry too large/);
});

await test('a duplicate entry name is rejected', { timeout: 10_000 }, () => {
  const zip = makeZip([
    { name: 'dup.txt', data: Buffer.from('one', 'utf8') },
    { name: 'dup.txt', data: Buffer.from('two', 'utf8') },
  ]);

  expectZipError(() => readZip(zip), /duplicate entry/);
});

await test('encrypted entries and unknown compression methods are rejected', { timeout: 10_000 }, () => {
  const encrypted = buildZip([{ name: 'secret.txt', data: Buffer.from('top secret', 'utf8') }]);

  encrypted.buffer.writeUInt16LE(1, encrypted.centralAt('secret.txt') + 8); // encryption flag
  expectZipError(() => readZip(encrypted.buffer), /encrypted/);

  const unsupported = buildZip([{ name: 'm.dat', data: Buffer.from('data', 'utf8') }]);

  unsupported.buffer.writeUInt16LE(12, unsupported.centralAt('m.dat') + 10); // BZIP2 method
  expectZipError(() => readZip(unsupported.buffer), /unsupported compression/);
});

await test('a declared size that does not match the inflated size is rejected', { timeout: 10_000 }, () => {
  for (const method of [0, 8] as const) {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello world', 'utf8'), method }]);
    const at = zip.centralAt('a.txt');

    zip.buffer.writeUInt32LE(zip.buffer.readUInt32LE(at + 24) + 1, at + 24);
    expectZipError(() => readZip(zip.buffer), /corrupt entry/);
  }
});

await test('zip64 archives are rejected', { timeout: 10_000 }, () => {
  expectZipError(
    () => readZip(makeZip([{ name: 'a.txt', data: Buffer.from('hi', 'utf8') }], { zip64: true })),
    /zip64/,
  );
});
