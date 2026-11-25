import assert from 'node:assert/strict';
import { test } from 'node:test';
import { powerZones } from '#src/world/power-zones';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

await test(
  'an FTP of 1 gives the very fractions of FTP the Sauce pages multiply themselves',
  { timeout: 10_000 },
  () => {
    const zones = powerZones(1);

    assert.deepEqual(zones, [
      { zone: 'Z1', name: 'Active Recovery', from: 0, to: 0.55 },
      { zone: 'Z2', name: 'Endurance', from: 0.55, to: 0.75 },
      { zone: 'Z3', name: 'Tempo', from: 0.75, to: 0.9 },
      { zone: 'Z4', name: 'Threshold', from: 0.9, to: 1.05 },
      { zone: 'Z5', name: 'VO2 Max', from: 1.05, to: 1.2 },
      { zone: 'Z6', name: 'Anaerobic', from: 1.2, to: 1.5 },
      { zone: 'Z7', name: 'Neuromuscular', from: 1.5, to: null },
    ]);
  },
);

await test('an FTP of 250 puts Threshold between 225 and 262.5 watts', { timeout: 10_000 }, () => {
  const zones = powerZones(250);
  const threshold = zones.find((zone) => zone.zone === 'Z4');

  assert.deepEqual(threshold, { zone: 'Z4', name: 'Threshold', from: 225, to: 262.5 });
});

await test('the zones are continuous and only the last one has no ceiling', { timeout: 10_000 }, () => {
  const zones = powerZones(193);

  assert.equal(zones.length, 7);

  for (const [index, zone] of zones.entries()) {
    assert.equal(zone.zone, `Z${index + 1}`);
    assert.ok(zone.name.length > 0);

    if (index + 1 < zones.length) {
      assert.equal(zone.to, zones[index + 1]?.from);
    } else {
      assert.equal(zone.to, null);
    }
  }

  assert.equal(zones[0]?.from, 0);
});

await test('an FTP that is no positive finite number falls back to 1', { timeout: 10_000 }, () => {
  for (const ftp of [0, -5, notANumber, Infinity]) {
    assert.deepEqual(powerZones(ftp), powerZones(1));
  }
});
