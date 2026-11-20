import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClimbProfile } from '#src/world/climb-profile';
import { FIT_EPOCH_S, climbProfileOf, locateClimb, mergeEffort, mergeProfile, rideStats } from '#src/world/climb-ride';
import type { Sample } from '#src/world/climb-ride';

const T0 = 1_000_000;

/** 1 Hz recording: 0.5 m/s before and after, 5 m/s between the samples 100 and 400 (a 1500 m climb gaining 150 m). */
const recording: Sample[] = Array.from({ length: 600 }, (_, i) => {
  const onClimb = Math.max(0, Math.min(i, 400) - 100);

  return {
    timestamp: T0 + i,
    distance: i * 0.5 + onClimb * 4.5,
    altitude: 13 + onClimb * 0.5,
    power: 250,
    heartRate: 150,
  };
});

const climb = recording.slice(100, 401);

await test('locateClimb finds the stretch that ended at the finish', () => {
  assert.deepEqual(locateClimb(recording, T0 + FIT_EPOCH_S + 400, 300, 1500), { from: 100, to: 400 });
});

await test('locateClimb finds it when the server clock is 30 s ahead', () => {
  assert.deepEqual(locateClimb(recording, T0 + FIT_EPOCH_S + 430, 300, 1500), { from: 100, to: 400 });
});

await test('locateClimb gives null for another length, no samples or bad input', () => {
  assert.equal(locateClimb(recording, T0 + FIT_EPOCH_S + 400, 300, 5000), null);
  assert.equal(locateClimb([], T0 + FIT_EPOCH_S + 400, 300, 1500), null);
  assert.equal(locateClimb(recording, T0 + FIT_EPOCH_S + 400, 0, 1500), null);
  assert.equal(locateClimb(recording, T0 + FIT_EPOCH_S + 400, 300, 0), null);
});

await test('rideStats reports start, time, power and heart rate', () => {
  assert.deepEqual(rideStats(climb), {
    startedAt: new Date((T0 + 100 + FIT_EPOCH_S) * 1000).toISOString(),
    elapsedMs: 300_000,
    avgPowerW: 250,
    maxPowerW: 250,
    avgHr: 150,
    maxHr: 150,
  });
});

await test('rideStats ignores a heart rate of 0 and gives null for fewer than two samples', () => {
  const noSensor = climb.map((sample, i) => ({ ...sample, heartRate: i % 2 === 0 ? 0 : 150 }));

  assert.equal(rideStats(noSensor)?.avgHr, 150);
  assert.equal(rideStats(climb.slice(0, 1)), null);
  assert.equal(rideStats([]), null);
});

await test('climbProfileOf gives a profile only for a ride with the length and climbing of the climb', () => {
  assert.equal(climbProfileOf(climb, { distanceM: 1500, elevationM: 150 })?.distanceM, 1500);
  assert.equal(climbProfileOf(climb, { distanceM: 1500, elevationM: 63 }), null);
  assert.equal(climbProfileOf(climb, { distanceM: 3000, elevationM: 150 }), null);
});

const effort = (startedAt: string) => ({
  startedAt,
  elapsedMs: 300_000,
  avgPowerW: 250,
  maxPowerW: 300,
  avgHr: 150,
  maxHr: 160,
});

await test('mergeEffort adds a ride, ignores the same ride and never changes its input', () => {
  const none = {};
  const one = mergeEffort(none, '10037', effort('2025-10-26T18:01:02.000Z'));

  assert.deepEqual(none, {});
  assert.equal(one['10037']?.length, 1);
  assert.equal(mergeEffort(one, '10037', effort('2025-10-26T18:01:05.000Z'))['10037']?.length, 1);
  assert.equal(mergeEffort(one, '10037', effort('2025-10-26T18:02:02.000Z'))['10037']?.length, 2);
  assert.equal(one['10037']?.length, 1);
});

await test('mergeProfile adds a profile only when the road has none and never changes its input', () => {
  const profile: ClimbProfile = {
    distanceM: 1500,
    elevationLowM: 13,
    elevationHighM: 163,
    avgGradePct: 10,
    maxGradePct: 12,
    category: null,
    points: [
      [0, 13],
      [1500, 163],
    ],
  };

  const none = {};
  const one = mergeProfile(none, '10050', profile);
  const other = mergeProfile(one, '10050', { ...profile, distanceM: 999 });

  assert.deepEqual(none, {});
  assert.equal(one['10050']?.distanceM, 1500);
  assert.equal(other['10050']?.distanceM, 1500);
});
