import type { Schema } from 'effect';
import { ModRegistry } from '#src/world/mods-registry';
import { ModValidationError } from '#src/world/mods-core';
import { installModZip } from '#src/world/mod-installer';
import { ZipError } from '#src/world/zip-reader';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

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

function makeZip(files: Array<ZipFile>): Buffer {
  const locals: Array<Buffer> = [];
  const central: Array<Buffer> = [];
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

    central.push(entry, nameBytes);
    centralSize += entry.length + nameBytes.length;
  }

  const tail: Array<Buffer> = [];

  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  tail.push(eocd);

  return Buffer.concat([...locals, ...central, ...tail]);
}

const MANIFEST = {
  manifest_version: 1,
  id: 'hill-radar',
  name: 'Hill Radar',
  description: 'd',
  version: '1',
  web_root: 'pages',
  windows: [{ file: 'pages/hill-radar.html', id: 'hill-radar', name: 'Hill Radar' }],
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mods-'));
}

function manifestJson(overrides: Readonly<Record<string, typeof Schema.Json.Type | undefined>> = {}): Buffer {
  return Buffer.from(JSON.stringify({ ...MANIFEST, ...overrides }), 'utf8');
}

function flatArchive(html = '<html>v1</html>'): Buffer {
  return makeZip([
    { name: 'manifest.json', data: manifestJson() },
    { name: 'pages/hill-radar.html', data: Buffer.from(html, 'utf8') },
  ]);
}

function expectThrow(run: () => void, message: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);

    return true;
  });
}

await test('a flat archive installs disabled under its manifest id', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const result = installModZip(root, flatArchive());

    assert.deepEqual(result, { id: 'hill-radar', replaced: false, skipped: 0 });
    assert.equal(readFileSync(join(root, 'hill-radar', 'manifest.json'), 'utf8'), JSON.stringify(MANIFEST));
    assert.equal(readFileSync(join(root, 'hill-radar', 'pages', 'hill-radar.html'), 'utf8'), '<html>v1</html>');

    const [entry] = new ModRegistry(root).list();

    assert.equal(entry?.id, 'hill-radar');
    assert.equal(entry?.status, 'disabled');
    assert.equal(entry?.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('an archive with one top-level directory installs the same way', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const archive = makeZip([
      { name: 's4z-hill-radar/manifest.json', data: manifestJson() },
      { name: 's4z-hill-radar/pages/hill-radar.html', data: Buffer.from('<html>v1</html>', 'utf8') },
    ]);

    const result = installModZip(root, archive);

    assert.deepEqual(result, { id: 'hill-radar', replaced: false, skipped: 0 });
    assert.equal(readFileSync(join(root, 'hill-radar', 'manifest.json'), 'utf8'), JSON.stringify(MANIFEST));
    assert.equal(readFileSync(join(root, 'hill-radar', 'pages', 'hill-radar.html'), 'utf8'), '<html>v1</html>');

    const [entry] = new ModRegistry(root).list();

    assert.equal(entry?.status, 'disabled');
    assert.equal(entry?.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a manifest without id takes the sanitized top-level directory name', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const archive = makeZip([
      { name: 'my-mod/manifest.json', data: manifestJson({ id: undefined }) },
      { name: 'my-mod/pages/hill-radar.html', data: Buffer.from('<html>v1</html>', 'utf8') },
    ]);

    const result = installModZip(root, archive);

    assert.deepEqual(result, { id: 'my-mod', replaced: false, skipped: 0 });
    assert.equal(readFileSync(join(root, 'my-mod', 'pages', 'hill-radar.html'), 'utf8'), '<html>v1</html>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('re-installing over an enabled mod reports replaced and leaves it changed', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    installModZip(root, flatArchive());

    const enabled = registry.setEnabled('hill-radar', true, registry.get('hill-radar')?.hash ?? '');

    assert.equal(enabled.enabled, true);

    const result = installModZip(root, flatArchive('<html>v2</html>'));

    assert.deepEqual(result, { id: 'hill-radar', replaced: true, skipped: 0 });

    const entry = registry.get('hill-radar');

    assert.equal(entry?.status, 'changed');
    assert.equal(entry?.enabled, false);
    assert.equal(readFileSync(join(root, 'hill-radar', 'pages', 'hill-radar.html'), 'utf8'), '<html>v2</html>');

    const leftovers = readdirSync(root).filter((name) => name.startsWith('.incoming-') || name.startsWith('.old-'));

    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('failed installs leave no mod directory and no staging directory', { timeout: 10_000 }, () => {
  const cases: Array<[string, () => Buffer, RegExp]> = [
    [
      'no manifest.json',
      () => makeZip([{ name: 'pages/hill-radar.html', data: Buffer.from('<html></html>', 'utf8') }]),
      /no manifest.json/,
    ],
    [
      'unknown manifest key',
      () =>
        makeZip([
          { name: 'manifest.json', data: manifestJson({ bogus_key: 'nope' }) },
          { name: 'pages/hill-radar.html', data: Buffer.from('<html></html>', 'utf8') },
        ]),
      /Unexpected key/,
    ],
    [
      'manifest is not JSON',
      () =>
        makeZip([
          { name: 'manifest.json', data: Buffer.from('not json at all {{{', 'utf8') },
          { name: 'pages/hill-radar.html', data: Buffer.from('<html></html>', 'utf8') },
        ]),
      /not valid JSON/,
    ],
    ['corrupt zip', () => Buffer.from('this text is definitely not a zip archive', 'utf8'), /not a zip file/],
  ];

  for (const [label, build, message] of cases) {
    const root = tempRoot();

    try {
      if (label === 'unknown manifest key') {
        assert.throws(() => installModZip(root, build()), ModValidationError);
      } else {
        expectThrow(() => installModZip(root, build()), message);
      }

      assert.deepEqual(readdirSync(root), [], `expected nothing left behind for: ${label}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

await test('a file with an unsafe name is skipped, not fatal', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const archive = makeZip([
      { name: 'manifest.json', data: manifestJson() },
      { name: 'pages/hill-radar.html', data: Buffer.from('<html>v1</html>', 'utf8') },
      { name: 'pages/a b.js', data: Buffer.from('x', 'utf8') },
    ]);

    const result = installModZip(root, archive);

    assert.deepEqual(result, { id: 'hill-radar', replaced: false, skipped: 1 });
    assert.equal(existsSync(join(root, 'hill-radar', 'pages', 'a b.js')), false);
    assert.equal(readFileSync(join(root, 'hill-radar', 'manifest.json'), 'utf8'), JSON.stringify(MANIFEST));
    assert.equal(readFileSync(join(root, 'hill-radar', 'pages', 'hill-radar.html'), 'utf8'), '<html>v1</html>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a whole-repository archive installs, skipping dot-directory entries', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const archive = makeZip([
      { name: 'manifest.json', data: manifestJson() },
      { name: '.github/workflows/ci.yml', data: Buffer.from('name: ci', 'utf8') },
      { name: '.gitignore', data: Buffer.from('node_modules', 'utf8') },
      { name: 'pages/hill-radar.html', data: Buffer.from('<html>v1</html>', 'utf8') },
    ]);

    const result = installModZip(root, archive);

    assert.deepEqual(result, { id: 'hill-radar', replaced: false, skipped: 2 });
    assert.equal(existsSync(join(root, 'hill-radar', '.github')), false);
    assert.equal(existsSync(join(root, 'hill-radar', '.gitignore')), false);
    assert.equal(readFileSync(join(root, 'hill-radar', 'manifest.json'), 'utf8'), JSON.stringify(MANIFEST));
    assert.equal(readFileSync(join(root, 'hill-radar', 'pages', 'hill-radar.html'), 'utf8'), '<html>v1</html>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a zip-slip entry is rejected and nothing is written outside the root', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const archive = makeZip([
      { name: 'manifest.json', data: manifestJson() },
      { name: '../../evil.txt', data: Buffer.from('evil', 'utf8') },
    ]);

    assert.throws(
      () => installModZip(root, archive),
      (error: unknown) => {
        assert.ok(error instanceof ZipError);
        assert.match(error.message, /unsafe path/);

        return true;
      },
    );

    assert.equal(existsSync(join(dirname(root), 'evil.txt')), false);
    assert.equal(existsSync(join(root, 'evil.txt')), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('archive limits are enforced', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    expectThrow(
      () => installModZip(root, flatArchive(), { maxEntries: 1, maxTotalBytes: 1000, maxEntryBytes: 1000 }),
      /too many entries/,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
