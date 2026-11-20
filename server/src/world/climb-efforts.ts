import { Schema, Option } from 'effect';

export const effortSchema = Schema.Struct({
  startedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)),
  elapsedMs: Schema.Int.check(Schema.isGreaterThan(0)),
  avgPowerW: Schema.NullOr(Schema.Number),
  maxPowerW: Schema.NullOr(Schema.Number),
  avgHr: Schema.NullOr(Schema.Number),
  maxHr: Schema.NullOr(Schema.Number),
});

export type Effort = typeof effortSchema.Type;

export type RideStats = {
  avgPowerW: number | null;
  maxPowerW: number | null;
  avgHr: number | null;
  maxHr: number | null;
};

export type RideLink = { provider: 'strava' | 'garmin' | 'intervals'; url: string };

export type RideInput = {
  activityId: number | null;
  rideAt: string | null;
  elapsedMs: number | null;
  links: RideLink[];
};

export type MergedRide = RideInput & { stats: RideStats | null };

/** Parse the rider's climb_efforts.json text; invalid JSON or non-object gives {}. */
export function parseClimbEfforts(text: string): Record<string, Effort[]> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  const recordOption = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(parsed);

  if (Option.isNone(recordOption)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(recordOption.value).flatMap(([road, value]) => {
      const listOption = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(value);
      const list = Option.isSome(listOption) ? listOption.value : [];

      const efforts = list.flatMap((item) => {
        const effortOption = Schema.decodeUnknownOption(effortSchema)(item);

        if (Option.isNone(effortOption)) return [];

        return [effortOption.value];
      });

      if (efforts.length === 0) return [];

      return [[road, efforts]];
    }),
  );
}

/** The most rides listed for one climb. */
const MAX_RIDES = 50;

const statsOf = (effort: Effort): RideStats => ({
  avgPowerW: effort.avgPowerW,
  maxPowerW: effort.maxPowerW,
  avgHr: effort.avgHr,
  maxHr: effort.maxHr,
});

/** Rides with a time first, fastest first (newest on a tie), then the others, newest first. */
const compareRides = (a: MergedRide, b: MergedRide) => {
  const timedA = a.elapsedMs !== null && a.elapsedMs > 0;
  const timedB = b.elapsedMs !== null && b.elapsedMs > 0;

  if (timedA !== timedB) return timedA ? -1 : 1;

  if (timedA && a.elapsedMs !== b.elapsedMs) return (a.elapsedMs ?? 0) - (b.elapsedMs ?? 0);

  return Date.parse(b.rideAt ?? '') - Date.parse(a.rideAt ?? '') || 0;
};

/** Match recorded efforts to rides by elapsed time; unmatched efforts become new rides. */
export function mergeEfforts(rides: ReadonlyArray<RideInput>, efforts: ReadonlyArray<Effort>): MergedRide[] {
  const merged: MergedRide[] = rides.map((ride) => ({ ...ride, stats: null }));
  const taken = new Set<number>();
  const added: MergedRide[] = [];

  for (const effort of efforts) {
    const tolerance = Math.max(2000, effort.elapsedMs * 0.02);
    let best = -1;
    let bestDifference = Infinity;

    for (const [index, ride] of merged.entries()) {
      if (taken.has(index) || ride.elapsedMs === null) continue;

      const difference = Math.abs(ride.elapsedMs - effort.elapsedMs);

      if (difference > tolerance || difference >= bestDifference) continue;

      best = index;
      bestDifference = difference;
    }

    const ride = merged[best];

    if (ride === undefined) {
      added.push({
        activityId: null,
        rideAt: effort.startedAt,
        elapsedMs: effort.elapsedMs,
        links: [],
        stats: statsOf(effort),
      });
      continue;
    }

    taken.add(best);
    merged[best] = { ...ride, rideAt: effort.startedAt, stats: statsOf(effort) };
  }

  return [...merged, ...added].sort(compareRides).slice(0, MAX_RIDES);
}
