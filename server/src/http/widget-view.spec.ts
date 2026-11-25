import { widgetGroupRecordSchema, widgetNearbyRecordSchema } from '#src/dtos/widget-api.dto';
import type { ViewSource } from '#src/http/widget-view';
import { athleteRecord, widgetView } from '#src/http/widget-view';
import type { OverlayRelation } from '#src/dtos/widget-api.dto';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { PlayerProfileSchema, Sport } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { StatsSample, StatsSnapshot } from '#src/world/live-stats';
import { RiderStats } from '#src/world/live-stats';
import { create } from '@bufbuild/protobuf';
import { Schema } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** course 6, road 100, travelling the road forwards. */
const roadFlag = (6 << 16) | 4;

const road100 = 100 << 8;

/** The fields a test packet changes; everything else stays at the protobuf default. */
type Values = Partial<
  Pick<
    PlayerState,
    | 'id'
    | 'distance'
    | 'roadTime'
    | 'laps'
    | 'speed'
    | 'heartrate'
    | 'power'
    | 'time'
    | 'f19'
    | 'aux3'
    | 'x'
    | 'yAltitude'
    | 'z'
    | 'route'
  >
>;

/** One rider on course 6, road 100, riding forwards at 36 km/h and 200 W. */
const packet = (fields: Values = {}): PlayerState =>
  create(PlayerStateSchema, {
    id: 1n,
    distance: 10_000,
    roadTime: 100_000,
    laps: 0,
    speed: 36_000_000,
    heartrate: 140,
    power: 200,
    time: 60,
    f19: roadFlag,
    aux3: road100,
    x: 1_000_000,
    yAltitude: 4200,
    z: 30,
    sport: Sport.CYCLING,
    route: 0,
    ...fields,
  });

const identity = create(PlayerProfileSchema, {
  firstName: 'John',
  lastName: 'Smith',
  isMale: true,
  weightInGrams: 72_500,
  ftp: 250,
});

const start = 1_000_000;

/** One second of riding at whole second `second`, with missing metrics left at zero. */
const sampleAt = (second: number, values: Partial<Omit<StatsSample, 'time'>> = {}): StatsSample => ({
  time: start + second * 1000,
  power: 0,
  heartrate: 0,
  speed: 0,
  cadence: 0,
  ...values,
});

/** `count` identical seconds of riding, enough for the 5, 15 and 60 second windows to have filled. */
const ride = (stats: RiderStats, count: number, values: Partial<Omit<StatsSample, 'time'>>): StatsSnapshot => {
  for (let second = 0; second < count; second += 1) {
    stats.push(sampleAt(second, values));
  }

  return stats.snapshot(250);
};

/** Three riders on one road: the watched one, one 50 m ahead and one 50 m behind it. */
const onOneRoad = (): Array<PlayerState> => [
  packet({ id: 1n, roadTime: 100_000, x: 1_000_000 }),
  packet({ id: 2n, roadTime: 100_500, x: 1_005_000 }),
  packet({ id: 3n, roadTime: 99_500, x: 995_000 }),
];

/** A source over the given packets, with statistics and profiles that never fail. */
const sourceOf = (
  watchingId: number,
  states: ReadonlyArray<PlayerState>,
  overrides: Partial<Pick<ViewSource, 'stats' | 'profile' | 'relations' | 'rideOns'>> = {},
): ViewSource => ({
  watchingId,
  states,
  stats: () => {},
  profile: () => identity,
  ...overrides,
});

/** Every nearby and group record has to be a record the widget pages would accept. */
const assertValid = (view: ReturnType<typeof widgetView>) => {
  for (const record of view.nearby) {
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
  }

  for (const group of view.groups) {
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetGroupRecordSchema)(group));
  }
};

await test('the view of a watched rider shows the riders ahead and behind it', { timeout: 10_000 }, () => {
  const view = widgetView(sourceOf(1, onOneRoad()));

  assertValid(view);

  assert.equal(view.nearby.length, 3);
  assert.deepEqual(
    view.nearby.map((record) => record.athleteId),
    [2, 1, 3],
  );

  // 50 m at 36 km/h is five seconds, negative for the rider in front.
  assert.ok(Math.abs((view.byId.get(2)?.gap ?? 0) + 5) < 1e-9);
  assert.ok(Math.abs((view.byId.get(3)?.gap ?? 0) - 5) < 1e-9);

  assert.equal(view.self?.athleteId, 1);
  assert.equal(view.self?.watching, true);
  assert.equal(view.self?.gap, 0);
  assert.equal(view.self?.state.speed, 36);
  assert.equal(view.self?.state.courseId, 6);
  assert.equal(view.self?.state.roadId, 100);
  assert.equal(view.self?.athlete.sanitizedFullname, 'John Smith');
});

await test('a watched rider that is not riding at all gives an empty view', { timeout: 10_000 }, () => {
  const view = widgetView(sourceOf(9, onOneRoad()));

  assert.equal(view.nearby.length, 0);
  assert.equal(view.groups.length, 0);
  assert.equal(view.self, null);
  assert.equal(view.byId.size, 0);
});

await test('a rider on another course is not part of the view', { timeout: 10_000 }, () => {
  const states = [...onOneRoad(), packet({ id: 4n, roadTime: 100_050, x: 1_000_500, f19: (7 << 16) | 4 })];

  const view = widgetView(sourceOf(1, states));

  assertValid(view);

  assert.deepEqual(
    view.nearby.map((record) => record.athleteId),
    [2, 1, 3],
  );
  assert.equal(view.byId.has(4), false);
  assert.equal(athleteRecord(view, 4), null);
});

await test(
  'statistics of a rider we do not track stay zero, of a tracked rider are its own',
  {
    timeout: 10_000,
  },
  () => {
    const stats = new Map<number, StatsSnapshot>([
      [3, ride(new RiderStats(), 40, { power: 250, heartrate: 150, speed: 32, cadence: 95 })],
    ]);

    const view = widgetView(sourceOf(1, onOneRoad(), { stats: (id) => stats.get(id) }));

    assertValid(view);

    const untracked = view.byId.get(2);
    const tracked = view.byId.get(3);

    assert.equal(untracked?.stats.power.avg, 0);
    assert.equal(untracked?.stats.power.max, 0);
    assert.deepEqual(untracked?.stats.power.smooth, []);
    assert.equal(untracked?.state.kj, 0);
    assert.equal(untracked?.lap.activeTime, 0);

    assert.equal(tracked?.stats.power.avg, 250);
    assert.equal(tracked?.state.kj, 10);
  },
);

await test('a profile is asked at most once per rider', { timeout: 10_000 }, () => {
  const asked: Array<number> = [];
  const profile = (id: number): PlayerProfile => {
    asked.push(id);

    return create(PlayerProfileSchema, { firstName: 'Rider', lastName: String(id), ftp: 200 });
  };

  const view = widgetView(sourceOf(1, onOneRoad(), { profile }));

  assertValid(view);

  // Every rider appears once: neither the groups nor the lookup ask for a profile again.
  assert.deepEqual(new Set(asked).size, asked.length);
  assert.deepEqual(asked, [2, 1, 3]);
  assert.equal(view.groups.length, 3);
  assert.equal(view.byId.get(2)?.athlete.sanitizedFullname, 'Rider 2');
});

await test('a rider is reachable by id or by the words self and watching', { timeout: 10_000 }, () => {
  const view = widgetView(sourceOf(1, onOneRoad()));

  assert.equal(athleteRecord(view, 'self'), view.self);
  assert.equal(athleteRecord(view, 'watching'), view.self);
  assert.equal(athleteRecord(view, 2)?.athleteId, 2);
  assert.equal(athleteRecord(view, 999), null);
});

await test('a rider a minute away is a pack of its own', { timeout: 10_000 }, () => {
  // One second ahead stays in the watched rider's pack, 600 m behind is 60 s and breaks it.
  const states: Array<PlayerState> = [
    packet({ id: 1n, roadTime: 100_000, x: 1_000_000 }),
    packet({ id: 2n, roadTime: 100_100, x: 1_001_000 }),
    packet({ id: 3n, roadTime: 40_000, x: 940_000 }),
  ];

  const stats = new Map<number, StatsSnapshot>([[1, ride(new RiderStats(), 20, { power: 210 })]]);

  const view = widgetView(sourceOf(1, states, { stats: (id) => stats.get(id) }));

  assertValid(view);

  assert.equal(view.groups.length, 2);

  const [front, back] = view.groups;

  assert.deepEqual(
    front?.athletes.map((athlete) => athlete.athleteId),
    [2, 1],
  );
  assert.deepEqual(
    back?.athletes.map((athlete) => athlete.athleteId),
    [3],
  );

  assert.equal(front?.watching, true);
  assert.equal(front?.gap, 0);
  assert.equal(back?.watching, false);
  assert.equal(front?.id, 1);
  assert.equal(back?.id, 3);

  // The gap of a group is measured to the member closest to the watched rider.
  assert.ok(Math.abs((back?.gap ?? 0) - 60) < 1e-9);
  assert.equal(front?.innerGap, 60);
  assert.deepEqual(
    front?.athletes.map((athlete) => athlete.stats.power.smooth.length),
    [0, 2],
  );
  assert.deepEqual(
    back?.athletes.map((athlete) => athlete.stats.power.smooth.length),
    [0],
  );
});

await test(
  'the group of the watched rider carries the same draft numbers as its athlete record',
  { timeout: 10_000 },
  () => {
    const stats = new Map<number, StatsSnapshot>([
      [1, ride(new RiderStats(), 60, { power: 200, draft: 42 })],
      [2, ride(new RiderStats(), 60, { power: 200, draft: 12 })],
    ]);

    const view = widgetView(sourceOf(1, onOneRoad(), { stats: (id) => stats.get(id) }));

    assertValid(view);

    // 50 m at 36 km/h is 5 s, far more than the 2 s group break, so each rider is a pack of one and
    // the watched pack holds only the watched rider with its own 42 W estimate.
    const pack = view.groups.find((group) => group.watching);

    assert.equal(pack?.draft, 42);
    assert.deepEqual(
      pack?.athletes.map((athlete) => athlete.state.draft),
      [42],
    );

    // The member entry and the athlete record of the same rider agree on the estimate, and every
    // pack carries its member's own draft.
    assert.equal(view.self?.state.draft, 42);
    assert.equal(pack?.athletes.find((athlete) => athlete.athleteId === 1)?.state.draft, view.self?.state.draft);
    assert.equal(view.byId.get(2)?.state.draft, 12);
    assert.equal(view.groups.find((group) => group.id === 2)?.draft, 12);

    // A pack of riders whose statistics nobody tracks stays at zero.
    const plain = widgetView(sourceOf(1, onOneRoad()));
    const own = plain.groups.find((group) => group.watching);

    assert.equal(own?.draft, 0);
    assert.deepEqual(
      own?.athletes.map((athlete) => athlete.state.draft),
      [0],
    );
  },
);

await test('the viewer relations reach the athlete records of the riders they belong to', { timeout: 10_000 }, () => {
  const relations: ReadonlyMap<number, OverlayRelation> = new Map([
    [2, { following: false, marked: true, muted: true }],
  ]);

  const view = widgetView(sourceOf(1, onOneRoad(), { relations }));

  assertValid(view);

  const markedNeighbour = view.byId.get(2)?.athlete;
  const otherNeighbour = view.byId.get(3)?.athlete;
  const watchedRider = view.self?.athlete;

  assert.equal(markedNeighbour?.marked, true);
  assert.equal(markedNeighbour?.muted, true);
  assert.equal(markedNeighbour?.following, false);

  for (const athlete of [otherNeighbour, watchedRider]) {
    assert.equal(athlete?.marked, false);
    assert.equal(athlete?.muted, false);
    assert.equal(athlete?.following, false);
  }
});

await test('the view reports the ride ons of every rider it builds a record for', { timeout: 10_000 }, () => {
  const counts = new Map<number, number>([[2, 5]]);
  const view = widgetView(sourceOf(1, onOneRoad(), { rideOns: (id) => counts.get(id) ?? 0 }));

  assert.equal(view.nearby.length, 3);
  assert.equal(view.byId.get(1)?.state.rideons, 0);
  assert.equal(view.byId.get(2)?.state.rideons, 5);
  assert.equal(view.byId.get(3)?.state.rideons, 0);
  assert.equal(view.self?.state.rideons, 0);
  assertValid(view);

  // Without the lookup every record stays at 0.
  assert.equal(widgetView(sourceOf(1, onOneRoad())).byId.get(2)?.state.rideons, 0);
});
