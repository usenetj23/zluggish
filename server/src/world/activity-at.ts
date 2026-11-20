export type ActivityRange = { id: number; startMs: number; endMs: number; stravaActivityId: number | bigint | null };

export function activityAt(rideAtMs: number, ranges: ReadonlyArray<ActivityRange>): ActivityRange | null {
  let best: ActivityRange | null = null;

  for (const range of ranges) {
    const contains = range.startMs <= rideAtMs && rideAtMs <= range.endMs;

    if (contains && (best === null || range.startMs > best.startMs)) best = range;
  }

  return best;
}
