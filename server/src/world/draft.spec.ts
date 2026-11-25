import { draftRangeSeconds, draftSaving, draftWatts, maxDraftSaving, nearestAhead } from '#src/world/draft';
import type { RiderPoint } from '#src/world/relations';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

/** A rider on road 7 of course 3, riding forward, with the metrics left at zero. */
const point = (id: number, values: Partial<Omit<RiderPoint, 'id'>> = {}): RiderPoint => ({
  id,
  course: 3,
  road: 7,
  forward: true,
  roadTime: 0,
  route: 0,
  distance: 0,
  x: 0,
  y: 0,
  z: 0,
  speed: 36,
  power: 200,
  heartrate: 140,
  ...values,
});

await test('the saving is the maximum at wheel level', { timeout: 10_000 }, () => {
  assert.equal(draftSaving(0), maxDraftSaving);
});

await test('the saving is half of the maximum at half the range', { timeout: 10_000 }, () => {
  assert.ok(Math.abs(draftSaving(draftRangeSeconds / 2) - maxDraftSaving / 2) < 1e-12);
});

await test('the saving falls to 0 exactly at the range and stays 0 beyond it', { timeout: 10_000 }, () => {
  assert.equal(draftSaving(draftRangeSeconds), 0);
  assert.equal(draftSaving(draftRangeSeconds + 0.001), 0);
  assert.equal(draftSaving(60), 0);
});

await test('the saving is 0 for a gap that is NaN or negative', { timeout: 10_000 }, () => {
  assert.equal(draftSaving(notANumber), 0);
  assert.equal(draftSaving(-0.5), 0);
  assert.equal(draftSaving(Infinity), 0);
});

await test('the saving decreases strictly as the gap grows within the range', { timeout: 10_000 }, () => {
  assert.ok(draftSaving(0.5) > draftSaving(1));
  assert.ok(draftSaving(1) > draftSaving(2));
  assert.ok(draftSaving(2) > draftSaving(2.4));
});

await test('there is no saving without a rider ahead', { timeout: 10_000 }, () => {
  assert.equal(draftWatts(200, 36, null), 0);
});

await test('there is no saving below the minimum draft speed', { timeout: 10_000 }, () => {
  assert.equal(draftWatts(200, 14, 2), 0);
});

await test('there is no saving for a power that is not a positive finite number', { timeout: 10_000 }, () => {
  assert.equal(draftWatts(0, 36, 2), 0);
  assert.equal(draftWatts(notANumber, 36, 2), 0);
  assert.equal(draftWatts(-100, 36, 2), 0);
  assert.equal(draftWatts(Infinity, 36, 2), 0);
});

await test('the watts saved are hand-computed for 200 W at 36 km/h 2 m behind', { timeout: 10_000 }, () => {
  const saved = draftWatts(200, 36, 2);

  // gap = 2 m / (36 km/h / 3.6) = 2 / 10 = 0.2 s; saving = 0.33 * (1 - 0.2 / 2.5).
  const saving = 0.33 * (1 - 0.2 / 2.5);
  const expected = 200 / (1 - saving) - 200;

  assert.ok(Math.abs(saved - expected) < 1e-9);
  assert.ok(saved > 0);
});

await test('the watts saved grow when the gap shrinks', { timeout: 10_000 }, () => {
  const near = draftWatts(250, 40, 1);
  const far = draftWatts(250, 40, 5);

  assert.ok(near > far);
  assert.ok(far > 0);
});

await test('the watts saved are 0 once the gap leaves the range', { timeout: 10_000 }, () => {
  // at 36 km/h the range of 2.5 s is 25 m; 30 m behind the rider ahead is out of the slipstream.
  assert.equal(draftWatts(200, 36, 30), 0);
});

await test('nearestAhead picks the nearest of several riders ahead', { timeout: 10_000 }, () => {
  const watched = point(1, { roadTime: 10_000_000, x: 0 });

  const distance = nearestAhead(watched, [
    point(2, { roadTime: 12_000_000, x: 30_000 }),
    point(3, { roadTime: 11_000_000, x: 15_000 }),
    point(4, { roadTime: 13_000_000, x: 50_000 }),
  ]);

  assert.equal(distance, 150);
});

await test('nearestAhead ignores riders behind and the watched rider itself', { timeout: 10_000 }, () => {
  const watched = point(1, { roadTime: 10_000_000, x: 0 });

  assert.equal(nearestAhead(watched, [point(1, { roadTime: 11_000_000, x: 5000 })]), null);
  assert.equal(nearestAhead(watched, [point(2, { roadTime: 9_000_000, x: -8000 })]), null);
});

await test('nearestAhead returns null for an empty list', { timeout: 10_000 }, () => {
  assert.equal(nearestAhead(point(1), []), null);
});

await test('nearestAhead ignores riders on another course', { timeout: 10_000 }, () => {
  const watched = point(1, { roadTime: 10_000_000, x: 0 });

  assert.equal(nearestAhead(watched, [point(2, { course: 4, roadTime: 11_000_000, x: 5000 })]), null);
});
