import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityLinks } from '#src/http/climb-links';

await test('strava id 123 produces only the strava link', () => {
  const result = activityLinks({ stravaActivityId: 123, remote: [] });

  assert.deepEqual(result, [{ provider: 'strava', url: 'https://www.strava.com/activities/123' }]);
});

await test('bigint strava id works', () => {
  const result = activityLinks({ stravaActivityId: 9_000_000_000_000n, remote: [] });

  assert.deepEqual(result, [{ provider: 'strava', url: 'https://www.strava.com/activities/9000000000000' }]);
});

await test('null strava id gives no strava link', () => {
  const result = activityLinks({ stravaActivityId: null, remote: [] });

  assert.deepEqual(result, []);
});

await test('zero strava id gives no strava link', () => {
  const result = activityLinks({ stravaActivityId: 0, remote: [] });

  assert.deepEqual(result, []);
});

await test('garmin remote produces garmin link', () => {
  const result = activityLinks({ stravaActivityId: null, remote: [{ provider: 'garmin', remote_id: '777' }] });

  assert.deepEqual(result, [{ provider: 'garmin', url: 'https://connect.garmin.com/modern/activity/777' }]);
});

await test('intervals remote produces intervals link', () => {
  const result = activityLinks({ stravaActivityId: null, remote: [{ provider: 'intervals', remote_id: 'i42' }] });

  assert.deepEqual(result, [{ provider: 'intervals', url: 'https://intervals.icu/activities/i42' }]);
});

await test('unknown provider zwift is ignored', () => {
  const result = activityLinks({ stravaActivityId: null, remote: [{ provider: 'zwift', remote_id: '99' }] });

  assert.deepEqual(result, []);
});

await test('input order garmin intervals strava still yields strava garmin intervals', () => {
  const result = activityLinks({
    stravaActivityId: 55,
    remote: [
      { provider: 'garmin', remote_id: 'g1' },
      { provider: 'intervals', remote_id: 'i1' },
    ],
  });

  assert.deepEqual(result, [
    { provider: 'strava', url: 'https://www.strava.com/activities/55' },
    { provider: 'garmin', url: 'https://connect.garmin.com/modern/activity/g1' },
    { provider: 'intervals', url: 'https://intervals.icu/activities/i1' },
  ]);
});

await test('id with slash is encoded as a%2Fb', () => {
  const result = activityLinks({ stravaActivityId: null, remote: [{ provider: 'garmin', remote_id: 'a/b' }] });

  assert.deepEqual(result, [{ provider: 'garmin', url: 'https://connect.garmin.com/modern/activity/a%2Fb' }]);
});
