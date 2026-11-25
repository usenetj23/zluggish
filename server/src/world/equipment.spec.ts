import { equipmentOf, loadBikeFrameNames } from '#src/world/equipment';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets', import.meta.url));

function assetsWith(content: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'game-info-'));
  mkdirSync(join(dir, 'data'));

  if (content !== undefined) {
    writeFileSync(join(dir, 'data/game_info.txt'), content, 'utf8');
  }

  return dir;
}

await test('the bike frame names come from the game info by frame id', () => {
  const frames = loadBikeFrameNames(assets);

  assert.ok(frames.size > 100);
  assert.equal(frames.get(2_454_550), 'Ventum One');
});

await test('a broken, incomplete or missing game info gives an empty map', () => {
  assert.equal(loadBikeFrameNames(assetsWith('not json')).size, 0);
  assert.equal(loadBikeFrameNames(assetsWith('{"maps":[]}')).size, 0);
  assert.equal(loadBikeFrameNames(assetsWith(undefined)).size, 0);
  assert.equal(loadBikeFrameNames(join(assets, 'no-such-dir')).size, 0);
});

await test('a profile with a bike frame gets cycling equipment', () => {
  const frames = new Map([[2_454_550, 'Ventum One']]);

  assert.deepEqual(equipmentOf({ bikeFrame: 2_454_550, bikeWheelFront: 10, bikeWheelRear: 20 }, frames), {
    cycling: {
      frame: { id: 2_454_550, name: 'Ventum One' },
      wheelFront: { id: 10, name: null },
      wheelRear: { id: 20, name: null },
    },
  });
});

await test('an unknown frame id keeps the id but has no name', () => {
  const equipment = equipmentOf({ bikeFrame: 7 }, new Map());

  assert.deepEqual(equipment.cycling?.frame, { id: 7, name: null });
});

await test('a profile without a frame has no cycling, and shoes alone give running', () => {
  assert.deepEqual(equipmentOf({ bikeWheelFront: 10, runShoesType: 3 }, new Map()), {
    running: { shoes: { id: 3, name: null } },
  });
});

await test('nothing set, and 0 treated as unset, give an empty equipment', () => {
  assert.deepEqual(equipmentOf({}, new Map()), {});
  assert.deepEqual(equipmentOf({ bikeFrame: 0, bikeWheelFront: 0, runShoesType: 0 }, new Map()), {});
});
