import { RideStats } from '#src/world/ride-stats';
import { RiderStats } from '#src/world/live-stats';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { worldTime, World } from '#src/world/state';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const id = 7n;

/** The metrics a test packet changes; everything else stays at the protobuf default. */
type Values = Partial<Pick<PlayerState, 'power' | 'heartrate' | 'speed' | 'cadenceUHz'>>;

/** One protocol packet of a rider whose world time advanced to whole second `second`. */
const packet = (second: number, values: Values = {}): PlayerState =>
  create(PlayerStateSchema, {
    id,
    worldTime: BigInt(1_000_000_000 + second * 1000),
    roadTime: 5000,
    power: 0,
    heartrate: 0,
    speed: 0,
    cadenceUHz: 0,
    ...values,
  });

/** `count` identical packets, one per whole second, starting at whole second `from`. */
const ride = (stats: RideStats, from: number, count: number, values: Values) => {
  for (let second = from; second < from + count; second += 1) {
    stats.receive(id, packet(second, values));
  }
};

await test(
  'protocol units become snapshot units: mm/h to km/h, micro-hertz to rpm, world time to seconds',
  { timeout: 10_000 },
  () => {
    const stats = new RideStats();
    const steadyRide = { speed: 36_000_000, cadenceUHz: 1_500_000, power: 200, heartrate: 140 };

    stats.receive(id, packet(0, steadyRide));

    assert.equal(stats.has(id), true);

    ride(stats, 1, 2, steadyRide);

    const steady = stats.snapshot(id, 0);

    assert.ok(steady);
    assert.equal(steady.activeTime, 3);
    assert.equal(steady.elapsedTime, 3);
    assert.equal(steady.power.avg, 200);
    assert.equal(steady.speed.avg, 36);
    assert.equal(steady.cadence.avg, 90);
    assert.equal(steady.hr.avg, 140);
  },
);

await test('an unknown rider has no snapshot and survives every other call', { timeout: 10_000 }, () => {
  const stats = new RideStats();

  assert.equal(stats.snapshot(id, 200), undefined);
  assert.equal(stats.has(id), false);

  stats.startLap(id);
  stats.reset(id);
  stats.forget(id);

  assert.equal(stats.has(id), false);
});

await test('forget drops a rider, reset clears the ride but keeps the rider', { timeout: 10_000 }, () => {
  const stats = new RideStats();

  ride(stats, 0, 3, { power: 200 });

  assert.equal(stats.has(id), true);
  assert.equal(stats.snapshot(id, 200)?.activeTime, 3);

  stats.reset(id);

  assert.equal(stats.has(id), true);
  assert.deepEqual(stats.snapshot(id, 200), new RiderStats().snapshot(200));

  ride(stats, 0, 2, { power: 100 });

  assert.equal(stats.snapshot(id, 200)?.activeTime, 2);
  assert.equal(stats.snapshot(id, 200)?.lastLap.activeTime, 0);

  stats.forget(id);

  assert.equal(stats.has(id), false);
  assert.equal(stats.snapshot(id, 200), undefined);
});

await test('startLap moves the finished lap to lastLap and starts counting again', { timeout: 10_000 }, () => {
  const stats = new RideStats();

  ride(stats, 0, 3, { power: 100, speed: 20_000_000, heartrate: 130 });
  stats.startLap(id);
  ride(stats, 3, 3, { power: 300, speed: 40_000_000, heartrate: 160 });

  const lap = stats.snapshot(id, 200);

  assert.ok(lap);
  assert.equal(lap.lap.power.avg, 300);
  assert.equal(lap.lap.activeTime, 3);
  assert.equal(lap.lastLap.power.avg, 100);
  assert.equal(lap.lastLap.activeTime, 3);
  assert.equal(lap.power.avg, 200);
});

await test(
  'the world feeds the ride statistics, keeps them over a logout and clears them on login',
  { timeout: 10_000 },
  () => {
    const world = new World();

    world.login(1n, new Uint8Array(16));
    world.receive(
      1n,
      create(PlayerStateSchema, {
        id: 1n,
        worldTime: worldTime(),
        roadTime: 1000,
        power: 250,
        speed: 30_000_000,
        cadenceUHz: 1_000_000,
        heartrate: 150,
      }),
    );

    assert.equal(world.rideStats.has(1n), true);
    assert.equal(world.rideStats.snapshot(1n, 0)?.power.avg, 250);

    world.logout(1n);

    assert.equal(world.rideStats.has(1n), true);

    world.login(1n, new Uint8Array(16));

    assert.equal(world.rideStats.has(1n), false);
    assert.equal(world.rideStats.snapshot(1n, 0), undefined);
  },
);

await test(
  'lapSpans follows the laps of one rider and answers nothing about an unknown rider',
  { timeout: 10_000 },
  () => {
    const stats = new RideStats();

    assert.deepEqual(stats.lapSpans(id), []);

    ride(stats, 0, 4, { power: 100 });
    stats.startLap(id);
    ride(stats, 4, 3, { power: 200 });

    assert.deepEqual(stats.lapSpans(id), [
      { id: 1, startSec: 1_000_000, endSec: 1_000_003 },
      { id: 2, startSec: 1_000_004, endSec: null },
    ]);

    stats.reset(id);

    assert.deepEqual(stats.lapSpans(id), []);
  },
);

await test(
  'a climbing ride reports a positive grade (distance and altitude reach the tracker)',
  { timeout: 10_000 },
  () => {
    const stats = new RideStats();

    for (let second = 0; second < 60; second += 1) {
      // 10 m per second, 0.5 m of climb per second: 5%; yAltitude is in cm with the 9000 offset.
      stats.receive(id, { ...packet(second), distance: second * 10, yAltitude: 9000 + second * 50 });
    }

    const grade = stats.snapshot(id, 250)?.grade ?? 0;

    assert.ok(grade > 0.03 && grade < 0.07, `grade ${grade}`);
  },
);
