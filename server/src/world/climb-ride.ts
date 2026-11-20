import type { ClimbProfile } from '#src/world/climb-profile';
import type { Effort } from '#src/world/climb-efforts';
import { summarizeStreams } from '#src/world/climb-streams';

/** FIT timestamps count seconds from 1989-12-31; unix seconds are the timestamp plus this. */
export const FIT_EPOCH_S = 631_065_600;

/** The fields of a FIT record that a climb ride is learned from. */
export type Sample = {
  timestamp?: number | undefined;
  distance?: number | undefined;
  altitude?: number | undefined;
  enhancedAltitude?: number | undefined;
  power?: number | undefined;
  heartRate?: number | undefined;
};

export type ClimbFacts = { distanceM: number; elevationM: number };

/** The server clock can differ from the clock of the recording by this much. */
const SEARCH_S = 90;

/** How far the distance of the located window may be from the length of the climb. */
const MAX_DISTANCE_ERROR = 0.12;

/** How far a recorded profile may be from the length and climbing of the climb it is learned for. */
const SIZE_TOLERANCE = 0.2;

/** Two efforts that start this close are the same ride. */
const SAME_RIDE_S = 5;

const within = (actual: number, expected: number) => Math.abs(actual - expected) <= expected * SIZE_TOLERANCE;

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

const peak = (values: ReadonlyArray<number>) => (values.length === 0 ? null : Math.max(...values));

/**
The stretch of a recording that is a climb which ended near `finishUnixS` and took `elapsedS`: the indexes of its
first and last sample, or null when no stretch covers about the length of the climb.
*/
export function locateClimb(
  samples: ReadonlyArray<Sample>,
  finishUnixS: number,
  elapsedS: number,
  expectedDistanceM: number,
) {
  if (elapsedS <= 0 || expectedDistanceM <= 0) return null;

  const timed = samples.flatMap((sample, index) =>
    sample.timestamp === undefined || sample.distance === undefined
      ? []
      : { index, time: sample.timestamp + FIT_EPOCH_S, distance: sample.distance },
  );

  const firstAtOrAfter = (time: number) => timed.find((item) => item.time >= time);

  let best: { from: number; to: number; error: number } | null = null;

  // The nearest end to the reported finish wins a tie.
  for (let shift = 0; shift <= SEARCH_S; shift++) {
    for (const end of shift === 0 ? [0] : [-shift, shift]) {
      const last = firstAtOrAfter(finishUnixS + end);
      const first = firstAtOrAfter(finishUnixS + end - elapsedS);

      if (!first || !last) continue;

      const error = Math.abs((last.distance - first.distance) / expectedDistanceM - 1);

      if (best === null || error < best.error) best = { from: first.index, to: last.index, error };
    }
  }

  return best !== null && best.error <= MAX_DISTANCE_ERROR ? { from: best.from, to: best.to } : null;
}

/** Start, time, power and heart rate of the samples (a heart rate of 0 is a missing sensor). */
export function rideStats(samples: ReadonlyArray<Sample>): Effort | null {
  const times = samples.flatMap((sample) => (sample.timestamp === undefined ? [] : sample.timestamp));
  const first = times.at(0);
  const last = times.at(-1);

  if (first === undefined || last === undefined || last <= first) return null;

  const powers = samples.flatMap((sample) => (sample.power === undefined ? [] : sample.power));

  const hearts = samples.flatMap((sample) =>
    sample.heartRate === undefined || sample.heartRate <= 0 ? [] : sample.heartRate,
  );

  return {
    startedAt: new Date((first + FIT_EPOCH_S) * 1000).toISOString(),
    elapsedMs: (last - first) * 1000,
    avgPowerW: mean(powers),
    maxPowerW: peak(powers),
    avgHr: mean(hearts),
    maxHr: peak(hearts),
  };
}

/**
The profile of a climb from the samples of a ride, only when the ride has the length and the climbing of the climb
(a recording of a longer road that merely contains the start of another climb does not).
*/
export function climbProfileOf(samples: ReadonlyArray<Sample>, facts: ClimbFacts): ClimbProfile | null {
  const rows = samples.flatMap((sample) => {
    const altitude = sample.enhancedAltitude ?? sample.altitude;

    return sample.distance === undefined || altitude === undefined ? [] : { distance: sample.distance, altitude };
  });

  const profile = summarizeStreams(
    rows.map((row) => row.distance),
    rows.map((row) => row.altitude),
  );

  if (profile === null) return null;

  const gain = profile.elevationHighM - profile.elevationLowM;

  return within(profile.distanceM, facts.distanceM) && within(gain, facts.elevationM) ? profile : null;
}

/** The efforts with this one added, unless a ride that started within seconds of it is already there. */
export function mergeEffort(existing: Readonly<Record<string, ReadonlyArray<Effort>>>, road: string, effort: Effort) {
  const known = existing[road] ?? [];
  const started = Date.parse(effort.startedAt);

  if (known.some((item) => Math.abs(Date.parse(item.startedAt) - started) <= SAME_RIDE_S * 1000))
    return { ...existing };

  return { ...existing, [road]: [...known, effort] };
}

/** The profiles with this one added, when the road has none yet. */
export function mergeProfile(existing: Readonly<Record<string, ClimbProfile>>, road: string, profile: ClimbProfile) {
  return road in existing ? { ...existing } : { ...existing, [road]: profile };
}
