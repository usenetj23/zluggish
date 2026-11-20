import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeEfforts, parseClimbEfforts, type Effort, type RideInput } from '#src/world/climb-efforts';

await test('parseClimbEfforts returns {} for invalid JSON, arrays and empty strings', () => {
  assert.deepEqual(parseClimbEfforts('not json'), {});
  assert.deepEqual(parseClimbEfforts('[]'), {});
  assert.deepEqual(parseClimbEfforts(''), {});
});

await test('parseClimbEfforts keeps valid efforts and drops invalid ones', () => {
  const text = JSON.stringify({
    '10052': [
      {
        startedAt: '2025-10-26T18:01:02.000Z',
        elapsedMs: 3_276_000,
        avgPowerW: 210,
        maxPowerW: 540,
        avgHr: 150,
        maxHr: 170,
      },
      { startedAt: 'bad', elapsedMs: 3_276_000, avgPowerW: 210, maxPowerW: 540, avgHr: 150, maxHr: 170 },
    ],
  });

  const result = parseClimbEfforts(text);

  assert.deepEqual(Object.keys(result), ['10052']);

  const list = result['10052'];

  assert.ok(list);
  assert.equal(list.length, 1);

  const first = list.at(0);

  assert.ok(first);
  assert.equal(first.avgPowerW, 210);
});

await test('mergeEfforts: exact elapsed match replaces rideAt and sets stats, keeps links', () => {
  const rides: RideInput[] = [
    {
      activityId: 1,
      rideAt: '2025-10-20T10:00:00.000Z',
      elapsedMs: 3_276_000,
      links: [{ provider: 'strava', url: 'https://www.strava.com/activities/1' }],
    },
  ];

  const efforts: Effort[] = [
    {
      startedAt: '2025-10-26T18:01:02.000Z',
      elapsedMs: 3_276_000,
      avgPowerW: 210,
      maxPowerW: 540,
      avgHr: 150,
      maxHr: 170,
    },
  ];

  const result = mergeEfforts(rides, efforts);

  assert.equal(result.length, 1);

  const first = result.at(0);

  assert.ok(first);
  assert.equal(first.rideAt, '2025-10-26T18:01:02.000Z');
  assert.equal(first.stats?.avgPowerW, 210);
  assert.deepEqual(first.links, [{ provider: 'strava', url: 'https://www.strava.com/activities/1' }]);
  assert.equal(first.activityId, 1);
});

await test('mergeEfforts: 1 percent away matches, 5 percent away does not and is appended as new ride', () => {
  const rides: RideInput[] = [{ activityId: 1, rideAt: '2025-10-20T10:00:00.000Z', elapsedMs: 3_000_000, links: [] }];

  const effort1: Effort = {
    startedAt: '2025-10-26T18:01:02.000Z',
    elapsedMs: 3_030_000,
    avgPowerW: 200,
    maxPowerW: 500,
    avgHr: 140,
    maxHr: 160,
  };

  const result1 = mergeEfforts(rides, [effort1]);

  assert.equal(result1.length, 1);

  const first1 = result1.at(0);

  assert.ok(first1);
  assert.equal(first1.stats?.avgPowerW, 200);

  const effort2: Effort = {
    startedAt: '2025-10-26T18:01:02.000Z',
    elapsedMs: 3_150_000,
    avgPowerW: 200,
    maxPowerW: 500,
    avgHr: 140,
    maxHr: 160,
  };

  const result2 = mergeEfforts(rides, [effort2]);

  assert.equal(result2.length, 2);

  const first2 = result2.at(0);

  assert.ok(first2);
  assert.equal(first2.stats, null);

  const second2 = result2.at(1);

  assert.ok(second2);
  assert.equal(second2.activityId, null);
  assert.equal(second2.stats?.avgPowerW, 200);
});

await test('mergeEfforts: two efforts never take the same ride', () => {
  const rides: RideInput[] = [{ activityId: 1, rideAt: '2025-10-20T10:00:00.000Z', elapsedMs: 3_000_000, links: [] }];

  const efforts: Effort[] = [
    {
      startedAt: '2025-10-26T18:01:02.000Z',
      elapsedMs: 3_000_000,
      avgPowerW: 200,
      maxPowerW: 500,
      avgHr: 140,
      maxHr: 160,
    },
    {
      startedAt: '2025-10-27T18:01:02.000Z',
      elapsedMs: 3_000_000,
      avgPowerW: 210,
      maxPowerW: 510,
      avgHr: 145,
      maxHr: 165,
    },
  ];

  const result = mergeEfforts(rides, efforts);

  assert.equal(result.length, 2);

  const taken = result.find((ride) => ride.activityId === 1);
  const added = result.find((ride) => ride.activityId === null);

  assert.ok(taken);
  assert.equal(taken.stats?.avgPowerW, 200);
  assert.equal(taken.rideAt, '2025-10-26T18:01:02.000Z');

  assert.ok(added);
  assert.equal(added.stats?.avgPowerW, 210);
  assert.equal(added.rideAt, '2025-10-27T18:01:02.000Z');
});

await test('mergeEfforts: ordering fastest first, ties newest rideAt first, then others newest first', () => {
  const rides: RideInput[] = [
    { activityId: 1, rideAt: '2025-10-20T10:00:00.000Z', elapsedMs: 600_000, links: [] },
    { activityId: 2, rideAt: '2025-10-21T10:00:00.000Z', elapsedMs: 540_000, links: [] },
    { activityId: 3, rideAt: '2025-10-19T10:00:00.000Z', elapsedMs: null, links: [] },
  ];

  const result = mergeEfforts(rides, []);

  const first = result.at(0);

  assert.ok(first);
  assert.equal(first.activityId, 2);

  const second = result.at(1);

  assert.ok(second);
  assert.equal(second.activityId, 1);

  const third = result.at(2);

  assert.ok(third);
  assert.equal(third.activityId, 3);
});

await test('mergeEfforts: 60 inputs give 50 outputs', () => {
  const rides: RideInput[] = [];

  for (let i = 0; i < 60; i++) {
    rides.push({
      activityId: i + 1,
      rideAt: `2025-10-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
      elapsedMs: 500_000 + i,
      links: [],
    });
  }

  const result = mergeEfforts(rides, []);

  assert.equal(result.length, 50);
});
