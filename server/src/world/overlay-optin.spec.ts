import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OverlayOptIn } from '#src/world/overlay-optin';

/** The per-rider opt-in of the Sauce Overlay pages: one tiny JSON file of the storage folder, only the
enabled riders listed, read lazily once and rewritten atomically. */

function storage() {
  const dir = mkdtempSync(join(tmpdir(), 'zluggish-overlay-optin-'));

  void test((t) => {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  });

  return dir;
}

const file = (dir: string) => join(dir, 'overlay-optin.json');

await test('the opt-in is off for everybody until a rider turns it on', () => {
  const dir = storage();
  const optIn = new OverlayOptIn(dir);

  assert.equal(optIn.enabled(1), false);
  assert.equal(optIn.enabled(99), false);

  optIn.set(1, true);

  assert.equal(optIn.enabled(1), true);
  assert.equal(optIn.enabled(2), false, 'one rider opt-in never reaches another');
});

await test('the opt-in survives a new instance reading the same file', () => {
  const dir = storage();

  new OverlayOptIn(dir).set(7, true);
  new OverlayOptIn(dir).set(9, true);

  const reloaded = new OverlayOptIn(dir);

  assert.equal(reloaded.enabled(7), true);
  assert.equal(reloaded.enabled(9), true);
  assert.equal(reloaded.enabled(8), false);
});

await test('disabling a rider removes its key from the file', () => {
  const dir = storage();
  const optIn = new OverlayOptIn(dir);

  optIn.set(3, true);
  optIn.set(4, true);
  optIn.set(3, false);

  assert.equal(optIn.enabled(3), false);

  const document: unknown = JSON.parse(readFileSync(file(dir), 'utf8'));

  assert.deepEqual(document, { '4': true });
});

await test('a missing, corrupt or wrong-shaped file behaves like an empty one and never throws', () => {
  const missing = new OverlayOptIn(storage());

  assert.equal(missing.enabled(1), false);

  for (const broken of ['{ not json', '[]', '"yes"', 'null', '7']) {
    const dir = storage();

    writeFileSync(file(dir), broken);

    const optIn = new OverlayOptIn(dir);

    assert.equal(optIn.enabled(1), false, broken);
  }

  // A document whose values are not `true` opts nobody in; a key that is no player id is skipped.
  const dir = storage();

  writeFileSync(file(dir), JSON.stringify({ '5': false, '0': true, '-2': true, x: true, '6': 'yes' }));

  const optIn = new OverlayOptIn(dir);

  assert.equal(optIn.enabled(5), false);
  assert.equal(optIn.enabled(6), false);
  assert.equal(optIn.enabled(0), false);
});

await test('the file is rewritten atomically and is always valid JSON with mode 0600', () => {
  const dir = storage();
  const optIn = new OverlayOptIn(dir);

  optIn.set(1, true);
  optIn.set(2, true);
  optIn.set(1, false);
  optIn.set(3, true);

  const document: unknown = JSON.parse(readFileSync(file(dir), 'utf8'));

  assert.deepEqual(document, { '2': true, '3': true });
  assert.equal(statSync(file(dir)).mode & 0o777, 0o600);

  // The temp file is gone: the rename is the only moment the target changes.
  assert.equal(statSync(dir).isDirectory(), true);
  assert.ok(!readFileSync(file(dir), 'utf8').includes('.tmp'));
});
