import { groupBreakSeconds, groupRiders, maxGapSeconds, minEstimateSpeed, nearby, relate } from '#src/world/relations';
import type { NearbyEntry, RiderPoint } from '#src/world/relations';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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

/** An entry of a neighbourhood: `gap` seconds from the watched rider, negative in front of it. */
const entry = (id: number, gap: number, values: Partial<Omit<NearbyEntry, 'id' | 'gap'>> = {}): NearbyEntry => ({
  id,
  self: false,
  gap,
  gapDistance: gap * 10,
  isGapEst: true,
  power: 200,
  speed: 30,
  heartrate: 140,
  ...values,
});

await test('riders on different courses cannot be placed relative to each other', { timeout: 10_000 }, () => {
  assert.equal(relate(point(1), point(2, { course: 4 })), null);
});

await test(
  'on the same road and in the same direction a larger roadTime is ahead, and the distance is measured in metres',
  { timeout: 10_000 },
  () => {
    const watched = point(1, { roadTime: 10_000_000 });

    const ahead = relate(watched, point(2, { roadTime: 12_000_000 }));
    assert.deepEqual(ahead, { ahead: true, distance: 0 });

    const behind = relate(watched, point(3, { roadTime: 8_000_000 }));
    assert.deepEqual(behind, { ahead: false, distance: 0 });

    // Riding the road backwards flips what "further along the road" means.
    const reversed = relate(
      point(1, { forward: false, roadTime: 10_000_000 }),
      point(2, { forward: false, roadTime: 12_000_000 }),
    );
    assert.deepEqual(reversed, { ahead: false, distance: 0 });

    // Centimetres of the world become metres: 3000 cm sideways and 4000 cm up is a 50 m line.
    const diagonal = relate(watched, point(2, { roadTime: 11_000_000, x: 3000, z: 4000 }));
    assert.equal(diagonal?.ahead, true);
    assert.equal(diagonal?.distance, 50);
  },
);

await test(
  'riders that do not share a road and a direction are compared by the route they both follow',
  { timeout: 10_000 },
  () => {
    // Same road but opposite directions: no road time comparison, so the route decides.
    const onRoute = relate(
      point(1, { route: 22, distance: 500 }),
      point(2, { forward: false, route: 22, distance: 620 }),
    );
    assert.deepEqual(onRoute, { ahead: true, distance: 120 });

    const behind = relate(
      point(1, { route: 22, distance: 500 }),
      point(2, { forward: false, route: 22, distance: 480 }),
    );
    assert.deepEqual(behind, { ahead: false, distance: 20 });

    // A route of 0 means "not on a route", so two riders with a 0 never match each other.
    assert.equal(
      relate(point(1, { route: 0, distance: 500 }), point(2, { forward: false, route: 0, distance: 620 })),
      null,
    );
    assert.equal(
      relate(point(1, { route: 22, distance: 500 }), point(2, { forward: false, route: 21, distance: 620 })),
      null,
    );

    // Different roads and different routes: nothing in common.
    assert.equal(relate(point(1, { road: 7, route: 22 }), point(2, { road: 8, route: 21 })), null);
  },
);

await test('the neighbourhood carries its sign and its gap in seconds', { timeout: 10_000 }, () => {
  const watched = point(1, { speed: 36, roadTime: 0, x: 0 });

  const front = nearby(watched, [point(2, { roadTime: 1_000_000, x: 10_000 })]);
  assert.equal(front.length, 2);
  assert.deepEqual(
    front.map((each) => each.id),
    [2, 1],
  );
  assert.equal(front[0]?.gapDistance, -100);
  assert.ok(Math.abs((front[0]?.gap ?? 0) + 10) <= 1e-9);
  assert.equal(front[0]?.isGapEst, true);
  assert.equal(front[0]?.self, false);

  const back = nearby(watched, [point(3, { roadTime: -1_000_000, x: -10_000 })]);
  assert.equal(back[1]?.gapDistance, 100);
  assert.ok(Math.abs((back[1]?.gap ?? 0) - 10) <= 1e-9);
});

await test('a standstill still estimates gaps, with the slowest credible speed', { timeout: 10_000 }, () => {
  const watched = point(1, { speed: 0 });

  const entries = nearby(watched, [point(2, { roadTime: 1_000_000, x: 10_000 })]);

  assert.equal(minEstimateSpeed, 10);
  assert.ok(Math.abs((entries[0]?.gap ?? 0) + 36) <= 1e-9);
});

await test(
  'the watched rider is one entry of its own neighbourhood, with a gap of zero',
  {
    timeout: 10_000,
  },
  () => {
    const watched = point(1, { power: 250, speed: 36, heartrate: 155 });

    const entries = nearby(watched, [point(1, { power: 0, speed: 0, heartrate: 0, roadTime: 999_000 })]);

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      id: 1,
      self: true,
      gap: 0,
      gapDistance: 0,
      isGapEst: false,
      power: 250,
      speed: 36,
      heartrate: 155,
    });
  },
);

await test('the neighbourhood is ordered from the rider in front to the one behind', { timeout: 10_000 }, () => {
  const watched = point(1);

  const entries = nearby(watched, [
    point(4, { roadTime: -50_000, x: -50_000 }),
    point(2, { roadTime: 2_000_000, x: 20_000 }),
    point(3, { roadTime: 1_000_000, x: 10_000 }),
    point(5, { roadTime: -10_000, x: -10_000 }),
  ]);

  assert.deepEqual(
    entries.map((each) => each.id),
    [2, 3, 1, 5, 4],
  );

  const gaps = entries.map((each) => each.gap);
  assert.deepEqual(
    gaps,
    [...gaps].sort((left, right) => left - right),
  );
});

await test('riders more than a quarter of an hour away are left out', { timeout: 10_000 }, () => {
  assert.equal(maxGapSeconds, 900);

  const watched = point(1, { speed: 36 });

  // 10 000 m at 36 km/h is 1000 s, past the cut, while 9000 m is exactly 900 s and stays.
  const entries = nearby(watched, [
    point(2, { roadTime: 1_000_000, x: 1_000_000 }),
    point(3, { roadTime: 2_000_000, x: 900_000 }),
  ]);

  assert.deepEqual(
    entries.map((each) => each.id),
    [3, 1],
  );
});

await test('a break of more than two seconds splits the neighbourhood into packs', { timeout: 10_000 }, () => {
  assert.equal(groupBreakSeconds, 2);

  const touching = groupRiders([entry(2, -2), entry(1, 0), entry(3, 2)]);
  assert.equal(touching.length, 1);
  assert.equal(touching[0]?.members.length, 3);

  const broken = groupRiders([entry(2, -2), entry(1, 0), entry(3, 2.1)]);
  assert.deepEqual(
    broken.map((group) => [...group.members].map((member) => member.id)),
    [[2, 1], [3]],
  );
});

await test('a group averages its power, takes the median speed and ignores flat hearts', { timeout: 10_000 }, () => {
  const odd = groupRiders([entry(1, 0, { speed: 40 }), entry(2, 0.5, { speed: 20 }), entry(3, 1, { speed: 30 })]);

  assert.equal(odd[0]?.speed, 30);

  const even = groupRiders([
    entry(1, 0, { speed: 40 }),
    entry(2, 0.5, { speed: 20 }),
    entry(3, 1, { speed: 30 }),
    entry(4, 1.5, { speed: 10 }),
  ]);
  assert.equal(even[0]?.speed, 25);

  const powers = groupRiders([entry(1, 0, { power: 300 }), entry(2, 0.5, { power: 0 }), entry(3, 1, { power: 150 })]);
  assert.equal(powers[0]?.power, 150);

  const hearts = groupRiders([
    entry(1, 0, { heartrate: 150 }),
    entry(2, 0.5, { heartrate: 0 }),
    entry(3, 1, { heartrate: 130 }),
  ]);
  assert.equal(hearts[0]?.heartrate, 140);

  const silent = groupRiders([entry(1, 0, { heartrate: 0 }), entry(2, 0.5, { heartrate: 0 })]);
  assert.equal(silent[0]?.heartrate, 0);

  const every = groupRiders([entry(1, 0), entry(2, 0.5)]);
  assert.equal(every[0]?.draft, 0);
});

await test(
  'each group is named by its smallest id, marked when we ride in it and gapped from its nearest member',
  { timeout: 10_000 },
  () => {
    const groups = groupRiders([
      entry(9, -12, { power: 300 }),
      entry(8, -10),
      entry(5, -4),
      entry(1, 0, { self: true, isGapEst: false }),
      entry(6, 1),
      entry(4, 20, { isGapEst: false }),
    ]);

    assert.equal(groups.length, 4);
    assert.deepEqual(
      groups.map((group) => group.id),
      [8, 5, 1, 4],
    );
    assert.deepEqual(
      groups.map((group) => group.watching),
      [false, false, true, false],
    );

    // A group in front is gapped by its last member, one behind by its first, our own group is 0.
    assert.ok(Math.abs((groups[0]?.gap ?? 0) + 10) <= 1e-9);
    assert.ok(Math.abs((groups[1]?.gap ?? 0) + 4) <= 1e-9);
    assert.equal(groups[2]?.gap, 0);
    assert.equal(groups[2]?.isGapEst, false);
    assert.ok(Math.abs((groups[3]?.gap ?? 0) - 20) <= 1e-9);
    assert.equal(groups[3]?.isGapEst, false);

    assert.deepEqual(
      [...(groups[0]?.members ?? [])].map((member) => member.gap),
      [-12, -10],
    );
  },
);

await test(
  'innerGap is the hole between a group and the next one, and zero after the last',
  { timeout: 10_000 },
  () => {
    const groups = groupRiders([entry(9, -12), entry(8, -10), entry(1, 0, { self: true }), entry(4, 20)]);

    assert.equal(groups.length, 3);
    assert.ok(Math.abs((groups[0]?.innerGap ?? 0) - 10) <= 1e-9);
    assert.ok(Math.abs((groups[1]?.innerGap ?? 0) - 20) <= 1e-9);
    assert.equal(groups[2]?.innerGap, 0);
  },
);

await test(
  'an empty neighbourhood makes no groups and the entries are never reordered in place',
  {
    timeout: 10_000,
  },
  () => {
    assert.deepEqual(groupRiders([]), []);

    const entries = [entry(3, 5), entry(1, 0, { self: true }), entry(2, -8)];
    const before = structuredClone(entries);

    const groups = groupRiders(entries);

    assert.deepEqual(entries, before);
    assert.deepEqual(
      groups.map((group) => [...group.members].map((member) => member.id)),
      [[2], [1], [3]],
    );
  },
);

await test(
  'a neighbourhood without the watched rider still numbers its packs from the front',
  {
    timeout: 10_000,
  },
  () => {
    const groups = groupRiders([entry(2, -10), entry(3, 5)]);

    assert.deepEqual(
      groups.map((group) => group.watching),
      [false, false],
    );
    assert.ok(Math.abs((groups[0]?.gap ?? 0) + 10) <= 1e-9);
    assert.ok(Math.abs((groups[1]?.gap ?? 0) - 5) <= 1e-9);
  },
);

await test('a column of five riders reads as two ahead, our own pack and one dropped', { timeout: 10_000 }, () => {
  const watched = point(1, { roadTime: 0, x: 0, speed: 36 });

  const entries = nearby(watched, [
    point(2, { roadTime: 2_500_000, x: 2500 }),
    point(3, { roadTime: 3_000_000, x: 3000 }),
    point(4, { roadTime: -1_000_000, x: -1000 }),
    point(5, { roadTime: -10_000_000, x: -10_000 }),
  ]);

  const groups = groupRiders(entries);

  assert.deepEqual(
    groups.map((group) => [...group.members].map((member) => member.id)),
    [[3, 2], [1, 4], [5]],
  );
  assert.deepEqual(
    groups.map((group) => group.watching),
    [false, true, false],
  );
  assert.ok(Math.abs((groups[0]?.gap ?? 0) + 2.5) <= 1e-9);
  assert.equal(groups[1]?.gap, 0);
  assert.ok(Math.abs((groups[2]?.gap ?? 0) - 10) <= 1e-9);
  assert.ok(Math.abs((groups[0]?.innerGap ?? 0) - 2.5) <= 1e-9);
  assert.ok(Math.abs((groups[1]?.innerGap ?? 0) - 9) <= 1e-9);
  assert.equal(groups[2]?.innerGap, 0);
});
