import { climbCategory } from '#src/world/climb-category';
import type { ClimbProfile } from '#src/world/climb-profile';

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Shortest stretch a maximum grade is measured over: the game's altitude is too noisy for shorter ones. */
const MAX_GRADE_WINDOW_M = 100;

/** The sample at an index; NaN when it does not exist, so callers reject it as not finite. */
const at = (values: ReadonlyArray<number>, index: number): number => values[index] ?? NaN;

/**
Turn Strava segment streams (cumulative distance + altitude) into a climb profile.
Returns null when the input is invalid (mismatched lengths, <2 samples, non-positive distance, non-finite values).
*/
export function summarizeStreams(
  distance: ReadonlyArray<number>,
  altitude: ReadonlyArray<number>,
  maxPoints = 60,
): ClimbProfile | null {
  if (distance.length !== altitude.length) return null;

  if (distance.length < 2) return null;

  const totalDistance = at(distance, distance.length - 1) - at(distance, 0);

  if (totalDistance <= 0) return null;

  for (let i = 0; i < distance.length; i++) {
    if (!Number.isFinite(at(distance, i)) || !Number.isFinite(at(altitude, i))) return null;
  }

  const distanceM = round1(totalDistance);
  const avgGradePct = round1(((at(altitude, altitude.length - 1) - at(altitude, 0)) / totalDistance) * 100);

  // maxGradePct: for each sample i, find first j > i with at(distance, j) - at(distance, i) >= MAX_GRADE_WINDOW_M
  let maxGrade = -Infinity;
  let foundWindow = false;

  for (let i = 0; i < distance.length - 1; i++) {
    for (let j = i + 1; j < distance.length; j++) {
      if (at(distance, j) - at(distance, i) >= MAX_GRADE_WINDOW_M) {
        const grade = ((at(altitude, j) - at(altitude, i)) / (at(distance, j) - at(distance, i))) * 100;

        if (grade > maxGrade) maxGrade = grade;

        foundWindow = true;

        break;
      }
    }
  }

  if (!foundWindow) {
    maxGrade = ((at(altitude, altitude.length - 1) - at(altitude, 0)) / totalDistance) * 100;
  }

  maxGrade = Math.max(0, round1(maxGrade));

  // elevation low / high
  let elevationLow = at(altitude, 0);
  let elevationHigh = at(altitude, 0);

  for (let i = 1; i < altitude.length; i++) {
    if (at(altitude, i) < elevationLow) elevationLow = at(altitude, i);

    if (at(altitude, i) > elevationHigh) elevationHigh = at(altitude, i);
  }

  const category = climbCategory(distanceM, avgGradePct);

  // points: at most maxPoints (at least 2), evenly spaced indexes, first and last always included
  const n = distance.length;
  const numPoints = Math.max(2, Math.min(maxPoints, n));
  const step = (n - 1) / (numPoints - 1);
  const points: Array<[number, number]> = [];

  for (let i = 0; i < numPoints; i++) {
    const idx = Math.round(i * step);
    const d = round1(at(distance, idx) - at(distance, 0));
    const a = round1(at(altitude, idx));

    const previous = points.at(-1);

    if (previous === undefined || d > previous[0]) points.push([d, a]);
  }

  return {
    distanceM,
    elevationLowM: round1(elevationLow),
    elevationHighM: round1(elevationHigh),
    avgGradePct,
    maxGradePct: maxGrade,
    category,
    points,
  };
}
