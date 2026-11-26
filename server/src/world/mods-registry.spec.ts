import { Schema } from 'effect';
import { ModRegistry } from '#src/world/mods-registry';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

const MANIFEST = {
  manifest_version: 1,
  id: 'hill-radar',
  name: 'Hill Radar',
  description: 'd',
  version: '0.5.0',
  web_root: 'pages',
  windows: [
    {
      file: 'pages/hill-radar.html',
      id: 'hill-radar',
      name: 'Hill Radar',
      description: 'Climbs',
      overlay: true,
      default_bounds: { width: 380, height: 300, x: -400, y: 100 },
    },
  ],
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mods-'));
}

function makeMod(
  root: string,
  dir: string,
  manifestOverrides: Readonly<Record<string, typeof Schema.Json.Type>> = {},
  extra: Record<string, string> = {},
): string {
  const modDir = join(root, dir);

  mkdirSync(join(modDir, 'pages'), { recursive: true });
  writeFileSync(join(modDir, 'manifest.json'), JSON.stringify({ ...MANIFEST, ...manifestOverrides }));
  writeFileSync(join(modDir, 'pages', 'hill-radar.html'), '<html></html>');

  for (const [path, contents] of Object.entries(extra)) {
    const target = join(modDir, path);

    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }

  return modDir;
}

const hashOf = (registry: ModRegistry, id: string): string => registry.get(id)?.hash ?? '';

const decodeStateFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        approvedHash: Schema.optionalKey(Schema.String),
        network: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
);

const stateOf = (root: string) => decodeStateFile(readFileSync(join(root, 'state.json'), 'utf8'));

await test('a fresh valid mod is disabled, listed with its files and an unapproved hash', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    makeMod(root, 'hill-radar');

    const [entry] = new ModRegistry(root).list();

    assert.equal(entry?.id, 'hill-radar');
    assert.equal(entry?.status, 'disabled');
    assert.equal(entry?.enabled, false);
    assert.deepEqual(
      entry?.files.map((file) => file.path),
      ['manifest.json', 'pages/hill-radar.html'],
    );
    assert.match(entry?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(entry?.approvedHash, null);
    assert.deepEqual(new ModRegistry(join(root, 'missing')).list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('enabling approves the hash into state.json', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'hill-radar');

    const enabled = registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    assert.equal(enabled.status, 'active');
    assert.equal(enabled.enabled, true);
    assert.equal(stateOf(root)['hill-radar']?.approvedHash, enabled.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('enabling with the wrong hash or no hash at all is refused and changes nothing', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'hill-radar');

    const listed = registry.get('hill-radar');
    const stateBefore = existsSync(join(root, 'state.json')) ? readFileSync(join(root, 'state.json'), 'utf8') : null;

    assert.throws(
      () => registry.setEnabled('hill-radar', true, 'f'.repeat(64)),
      /mod changed since it was reviewed; reload and review it again/,
    );
    assert.throws(() => registry.setEnabled('hill-radar', true), /mod changed since it was reviewed/);

    assert.equal(registry.get('hill-radar')?.enabled, false);

    if (stateBefore === null) {
      assert.equal(existsSync(join(root, 'state.json')), false);
    } else {
      assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), stateBefore);
    }

    // The hash that was listed is the one that is approved.
    const enabled = registry.setEnabled('hill-radar', true, listed!.hash);

    assert.equal(enabled.status, 'active');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a hash listed before the files changed no longer approves the mod', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = makeMod(root, 'hill-radar');
    const staleHash = registry.get('hill-radar')!.hash;

    writeFileSync(join(modDir, 'pages', 'hill-radar.html'), '<html>trojan</html>');

    assert.throws(
      () => registry.setEnabled('hill-radar', true, staleHash),
      /mod changed since it was reviewed; reload and review it again/,
    );
    assert.equal(registry.get('hill-radar')?.enabled, false);

    // Disabling never needs a hash.
    registry.setEnabled('hill-radar', true, registry.get('hill-radar')!.hash);

    assert.equal(registry.setEnabled('hill-radar', false).enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a rewritten file marks the mod changed until it is re-approved', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = makeMod(root, 'hill-radar');
    const approved = registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    writeFileSync(join(modDir, 'pages', 'hill-radar.html'), '<html>changed</html>');

    const changed = registry.get('hill-radar');

    assert.equal(changed?.status, 'changed');
    assert.equal(changed?.enabled, false);

    const reapproved = registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    assert.equal(reapproved.status, 'active');
    assert.notEqual(reapproved.hash, approved.hash);

    const disabled = registry.setEnabled('hill-radar', false);

    assert.equal(disabled.status, 'disabled');
    assert.equal(stateOf(root)['hill-radar']?.approvedHash, reapproved.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('an invalid manifest is reported and refuses to be enabled', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'odd-mod', { bogus: 1 });

    const [entry] = registry.list();

    assert.equal(entry?.status, 'invalid');
    assert.ok((entry?.error ?? '').length > 0);
    assert.equal(entry?.manifest, null);
    assert.throws(() => registry.setEnabled('odd-mod', true), /invalid mod/);
    assert.throws(() => registry.setEnabled('nope', true), /unknown mod/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test(
  'network defaults to false and setNetwork persists it without touching enabled/approvedHash',
  { timeout: 10_000 },
  () => {
    const root = tempRoot();

    try {
      const registry = new ModRegistry(root);

      makeMod(root, 'hill-radar');

      // Absent in state.json -> false on every entry.
      assert.equal(registry.get('hill-radar')?.network, false);
      assert.equal(
        registry.list().every((entry) => !entry.network),
        true,
      );

      const approved = registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

      registry.setNetwork('hill-radar', true);

      const entry = registry.get('hill-radar');

      assert.equal(entry?.network, true);
      assert.equal(entry?.enabled, true);
      assert.equal(entry?.approvedHash, approved.hash);
      assert.equal(stateOf(root)['hill-radar']?.network, true);
      assert.equal(stateOf(root)['hill-radar']?.enabled, true);
      assert.equal(stateOf(root)['hill-radar']?.approvedHash, approved.hash);

      registry.setNetwork('hill-radar', false);

      assert.equal(registry.get('hill-radar')?.network, false);
      assert.equal(registry.get('hill-radar')?.enabled, true);

      // A mod without a state record gets one (enabled false).
      makeMod(root, 'other-mod', { id: 'other-mod' });
      registry.setNetwork('other-mod', true);

      assert.equal(registry.get('other-mod')?.network, true);
      assert.equal(registry.get('other-mod')?.enabled, false);
      assert.equal(stateOf(root)['other-mod']?.enabled, undefined);

      assert.throws(() => registry.setNetwork('nope', true), /unknown mod/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

await test('a changed mod hash keeps the network permission', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = makeMod(root, 'hill-radar');

    registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));
    registry.setNetwork('hill-radar', true);

    writeFileSync(join(modDir, 'pages', 'hill-radar.html'), '<html>changed</html>');

    const changed = registry.get('hill-radar');

    assert.equal(changed?.status, 'changed');
    assert.equal(changed?.enabled, false);
    assert.equal(changed?.network, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('unsafe directory names and loose files in the root are skipped', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    makeMod(root, 'hill-radar');
    mkdirSync(join(root, 'bad name'));
    writeFileSync(join(root, 'note.txt'), 'skip me');

    assert.deepEqual(
      new ModRegistry(root).list().map((entry) => entry.dir),
      [join(root, 'hill-radar')],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('symlinks inside a mod are neither listed nor served', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = makeMod(root, 'hill-radar');

    symlinkSync('/etc/hosts', join(modDir, 'pages', 'link.html'));
    registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    const entry = registry.get('hill-radar');

    assert.ok(!entry?.files.some((file) => file.path === 'pages/link.html'));
    assert.equal(registry.fileOf('hill-radar', 'pages/link.html'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('windowManifests describes every window of an active mod only', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'hill-radar');

    assert.deepEqual(registry.windowManifests(), []);

    registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    const [window] = registry.windowManifests();

    assert.equal(registry.windowManifests().length, 1);
    assert.equal(window?.['type'], 'hill-radar-hill-radar');
    assert.equal(window?.['file'], '/mods/hill-radar/pages/hill-radar.html');
    assert.equal(window?.['modId'], 'hill-radar');
    assert.equal(window?.['groupTitle'], '[MOD]: Hill Radar');
    assert.equal(window?.['prettyName'], 'Hill Radar');
    assert.equal(window?.['overlay'], true);

    assert.equal(window?.options.width, 380);
    assert.equal(window?.options.x, -400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('fileOf serves active mod files and refuses everything else', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'hill-radar');
    registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));

    const served = registry.fileOf('hill-radar', 'pages/hill-radar.html');

    assert.equal(served?.size, 13);
    assert.ok((served?.absolute ?? '').endsWith('hill-radar.html'));

    const rejected: Array<[string, string]> = [
      ['hill-radar', '../x'],
      ['hill-radar', '/etc/passwd'],
      ['nope', 'a.html'],
    ];

    for (const [id, path] of rejected) {
      assert.equal(registry.fileOf(id, path), null);
    }

    registry.setEnabled('hill-radar', false);

    assert.equal(registry.fileOf('hill-radar', 'pages/hill-radar.html'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('remove deletes the directory and forgets the state entry', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = makeMod(root, 'hill-radar');

    registry.setEnabled('hill-radar', true, hashOf(registry, 'hill-radar'));
    registry.remove('hill-radar');

    assert.equal(existsSync(modDir), false);
    assert.deepEqual(stateOf(root), {});
    assert.throws(() => registry.remove('nope'), /unknown mod/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('the second mod claiming an id is invalid as a duplicate', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    makeMod(root, 'a');
    makeMod(root, 'b');

    const [first, second] = new ModRegistry(root).list();

    assert.equal(first?.status, 'disabled');
    assert.equal(first?.error, null);
    assert.equal(first?.dir, join(root, 'a'));
    assert.equal(second?.status, 'invalid');
    assert.equal(second?.error, 'duplicate mod id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('contentFiles collects scripts and styles of active mods only', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(
      root,
      'with-content',
      { id: 'with-content', content_js: ['pages/src/data-fields.js'], content_css: ['pages/css/x.css'] },
      { 'pages/src/data-fields.js': 'x', 'pages/css/x.css': 'y' },
    );
    makeMod(root, 'off-mod', { id: 'off-mod', content_js: ['pages/src/off.js'], content_css: ['pages/css/off.css'] });

    registry.setEnabled('with-content', true, hashOf(registry, 'with-content'));

    assert.deepEqual(registry.contentFiles(), {
      scripts: ['/mods/with-content/pages/src/data-fields.js'],
      styles: ['/mods/with-content/pages/css/x.css'],
    });

    // a disabled mod contributes nothing
    assert.equal(registry.get('off-mod')?.status, 'disabled');

    // a changed mod contributes nothing
    writeFileSync(join(root, 'with-content', 'pages', 'hill-radar.html'), '<html>changed</html>');

    assert.equal(registry.get('with-content')?.status, 'changed');
    assert.deepEqual(registry.contentFiles(), { scripts: [], styles: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('isContentFile accepts only declared content files of an active mod', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(
      root,
      'with-content',
      { id: 'with-content', content_js: ['pages/src/data-fields.js'], content_css: ['pages/css/x.css'] },
      { 'pages/src/data-fields.js': 'x', 'pages/css/x.css': 'y' },
    );
    makeMod(root, 'off-mod', { id: 'off-mod', content_js: ['pages/src/data-fields.js'] });

    registry.setEnabled('with-content', true, hashOf(registry, 'with-content'));
    registry.setEnabled('off-mod', true, hashOf(registry, 'off-mod'));
    registry.setEnabled('off-mod', false);

    assert.equal(registry.isContentFile('with-content', 'pages/src/data-fields.js'), true);
    assert.equal(registry.isContentFile('with-content', 'pages/css/x.css'), true);
    assert.equal(registry.isContentFile('with-content', 'pages/src/other.js'), false);
    assert.equal(registry.isContentFile('with-content', 'pages/hill-radar.html'), false);
    assert.equal(registry.isContentFile('nope', 'pages/src/data-fields.js'), false);
    assert.equal(registry.isContentFile('off-mod', 'pages/src/data-fields.js'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('a content_js path failing isSafePath makes the manifest invalid', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'bad-content', { id: 'bad-content', content_js: ['../x.js'] });

    const [entry] = registry.list();

    assert.equal(entry?.status, 'invalid');
    assert.deepEqual(registry.contentFiles(), { scripts: [], styles: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test(
  'the hash cache: a second get() reads no file contents, an edited file recomputes it',
  { timeout: 10_000 },
  () => {
    const root = tempRoot();

    try {
      const registry = new ModRegistry(root);
      const modDir = makeMod(root, 'hill-radar');

      const first = registry.get('hill-radar');
      const readsAfterFirst = registry.reads();

      assert.ok(readsAfterFirst >= 2);

      // Repeated lookups (get/fileOf/isContentFile pattern of one request) never read contents again.
      const again = registry.get('hill-radar');

      assert.equal(again?.hash, first?.hash);
      assert.equal(registry.reads(), readsAfterFirst);

      // An edit changes size/mtime: the SHA is recomputed on the next call and the hash follows it.
      writeFileSync(join(modDir, 'pages', 'hill-radar.html'), '<html>much longer than before</html>');

      const edited = registry.get('hill-radar');

      assert.ok(registry.reads() > readsAfterFirst);
      assert.notEqual(edited?.hash, first?.hash);

      // A new file (same size as an existing one) also changes the fingerprint.
      writeFileSync(join(modDir, 'pages', 'x.html'), '<html></html>');

      const withExtra = registry.get('hill-radar');

      assert.notEqual(withExtra?.hash, edited?.hash);
      assert.deepEqual(
        withExtra?.files.map((file) => file.path),
        ['manifest.json', 'pages/hill-radar.html', 'pages/x.html'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

await test('setEnabled and remove invalidate the cache', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);

    makeMod(root, 'hill-radar');
    makeMod(root, 'other', { id: 'other' });

    const hash = hashOf(registry, 'hill-radar');
    const reads = registry.reads();

    assert.ok(reads >= 4);

    registry.setEnabled('hill-radar', true, hash);

    // The write dropped the cache: the entry is rebuilt from a fresh scan.
    assert.ok(registry.reads() > reads);
    assert.equal(registry.get('hill-radar')?.status, 'active');

    const beforeRemove = registry.reads();

    registry.setEnabled('hill-radar', false);

    assert.ok(registry.reads() > beforeRemove);

    // 'other' was scanned before (2 files); the remove's writeState cleared the cache, so its next
    // list() reads its contents again.
    const before = registry.reads();

    registry.remove('hill-radar');

    assert.equal(registry.get('hill-radar'), undefined);
    assert.equal(registry.get('other')?.status, 'disabled');
    assert.ok(registry.reads() > before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('an invalid manifest never leaks a filesystem path into the entry error', { timeout: 10_000 }, () => {
  const root = tempRoot();

  try {
    const registry = new ModRegistry(root);
    const modDir = join(root, 'no-manifest');

    mkdirSync(join(modDir, 'pages'), { recursive: true });
    writeFileSync(join(modDir, 'pages', 'a.html'), '<html></html>');

    const missing = registry.get('no-manifest');

    assert.equal(missing?.status, 'invalid');
    assert.equal(missing?.error, 'manifest.json is missing or unreadable');
    assert.ok(!(missing?.error ?? '').includes('/'));
    assert.ok(!(missing?.error ?? '').includes(sep));
    assert.ok((missing?.detail ?? '').includes(modDir)); // the full message stays server-side only

    // Broken JSON: no path either.
    const broken = join(root, 'broken-json');

    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'manifest.json'), '{ not json');

    const entry = registry.get('broken-json');

    assert.equal(entry?.status, 'invalid');
    assert.equal(entry?.error, 'manifest.json is not valid JSON');
    assert.ok(!(entry?.error ?? '').includes('/'));

    // A schema failure keeps its field-level text; a value quoting a path does not survive.
    makeMod(root, 'odd-mod', { bogus: 1 });

    const schema = registry.get('odd-mod');

    assert.equal(schema?.error, 'bogus: Unexpected key');

    makeMod(root, 'path-value', { id: 'path-value', web_root: join(root, 'elsewhere') });

    const leaking = registry.get('path-value');

    assert.equal(leaking?.status, 'invalid');
    assert.ok(!(leaking?.error ?? '').includes('/'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
