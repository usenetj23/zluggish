import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityAt, type ActivityRange } from '#src/world/activity-at';

await test('ride inside a range returns that range', () => {
  const ranges: ActivityRange[] = [{ id: 1, startMs: 100, endMs: 500, stravaActivityId: null }];

  const result = activityAt(300, ranges);

  assert.equal(result?.id, 1);
});

await test('ride exactly at start returns that range', () => {
  const ranges: ActivityRange[] = [{ id: 1, startMs: 100, endMs: 500, stravaActivityId: null }];

  const result = activityAt(100, ranges);

  assert.equal(result?.id, 1);
});

await test('ride exactly at end returns that range', () => {
  const ranges: ActivityRange[] = [{ id: 1, startMs: 100, endMs: 500, stravaActivityId: null }];

  const result = activityAt(500, ranges);

  assert.equal(result?.id, 1);
});

await test('ride 1 ms before start returns null', () => {
  const ranges: ActivityRange[] = [{ id: 1, startMs: 100, endMs: 500, stravaActivityId: null }];

  const result = activityAt(99, ranges);

  assert.equal(result, null);
});

await test('ride 1 ms after end returns null', () => {
  const ranges: ActivityRange[] = [{ id: 1, startMs: 100, endMs: 500, stravaActivityId: null }];

  const result = activityAt(501, ranges);

  assert.equal(result, null);
});

await test('two overlapping ranges, ride at 300 returns the one with latest start', () => {
  const ranges: ActivityRange[] = [
    { id: 1, startMs: 100, endMs: 500, stravaActivityId: null },
    { id: 2, startMs: 200, endMs: 400, stravaActivityId: null },
  ];

  const result = activityAt(300, ranges);

  assert.equal(result?.id, 2);
});

await test('empty list returns null', () => {
  const result = activityAt(300, []);

  assert.equal(result, null);
});
