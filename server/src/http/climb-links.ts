export function activityLinks(input: {
  stravaActivityId: number | bigint | null;
  remote: ReadonlyArray<{ provider: string; remote_id: string }>;
}): Array<{ provider: 'strava' | 'garmin' | 'intervals'; url: string }> {
  const links: Array<{ provider: 'strava' | 'garmin' | 'intervals'; url: string }> = [];

  if (input.stravaActivityId !== null && input.stravaActivityId !== 0) {
    links.push({ provider: 'strava', url: `https://www.strava.com/activities/${input.stravaActivityId}` });
  }

  const garmin = input.remote.find((r) => r.provider === 'garmin');

  if (garmin) {
    links.push({
      provider: 'garmin',
      url: `https://connect.garmin.com/modern/activity/${encodeURIComponent(garmin.remote_id)}`,
    });
  }

  const intervals = input.remote.find((r) => r.provider === 'intervals');

  if (intervals) {
    links.push({
      provider: 'intervals',
      url: `https://intervals.icu/activities/${encodeURIComponent(intervals.remote_id)}`,
    });
  }

  return links;
}
