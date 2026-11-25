/**
The watts a rider saves in the slipstream of the rider in front, in the convention of the Sauce for
Zwift widget pages, which show `state.draft` in watts next to its average and its energy.

The Zwift protocol never reports drafting, so this is an ESTIMATE: a simple model, not Zwift's own
physics. Zwift hides its slipstream inside the world simulation and says nothing about it in the
packets, so the only shape that can be rebuilt from the packets alone is a decay against the gap:
the nearer the rider ahead, the larger the share of the power that the air no longer demands. A
linear ramp from the maximum saving at wheel level down to nothing at a fixed gap is the smallest
model with that shape, and every one of its numbers is a named constant so a later measurement
against Zwift's own power traces can retune it in one place. Plain arithmetic, with no access to
the world, the protocol or the clock, so the same numbers can be checked in a test.
*/

import { relate } from '#src/world/relations';
import type { RiderPoint } from '#src/world/relations';

/** The share of the power saved by a rider sitting right behind another: a third less for the same speed. */
export const maxDraftSaving = 0.33;

/** The gap in seconds at which the saving has fallen to nothing; it decays linearly from wheel level to here. */
export const draftRangeSeconds = 2.5;

/** Below this speed in km/h there is no draft at all; nobody drafts a crawling rider. */
export const minDraftSpeed = 15;

/**
The saved share of the power for a gap in seconds: the maximum at wheel level, falling linearly to
nothing at `draftRangeSeconds`, and 0 for a gap that is NaN, negative or beyond the range.
*/
export function draftSaving(gapSeconds: number): number {
  if (!Number.isFinite(gapSeconds) || gapSeconds < 0 || gapSeconds >= draftRangeSeconds) {
    return 0;
  }

  return maxDraftSaving * (1 - gapSeconds / draftRangeSeconds);
}

/**
The watts the rider saves by riding `distanceAheadMetres` behind the rider in front. The rider does
`power` watts WITH the draft; the same speed without it would need `power / (1 - saving)`, so the
saving is the difference. 0 when there is no rider ahead, the speed is below `minDraftSpeed` or the
power is not a positive finite number. Nothing is rounded.
*/
export function draftWatts(power: number, speedKmh: number, distanceAheadMetres: number | null): number {
  if (distanceAheadMetres === null || !Number.isFinite(power) || power <= 0 || speedKmh < minDraftSpeed) {
    return 0;
  }

  const gapSeconds = distanceAheadMetres / (speedKmh / 3.6);
  const saving = draftSaving(gapSeconds);

  if (saving <= 0) {
    return 0;
  }

  return power / (1 - saving) - power;
}

/**
The distance in metres to the nearest rider ahead of `watching`, or null when nobody is ahead or
none of them can be compared. Only riders within a plausible range matter, but no range constant is
needed here: an out-of-range rider simply yields a saving of 0 once `draftWatts` divides its
distance into a gap.
*/
export function nearestAhead(watching: RiderPoint, others: ReadonlyArray<RiderPoint>): number | null {
  let nearest: number | null = null;

  for (const other of others) {
    if (other.id === watching.id) {
      continue;
    }

    const relation = relate(watching, other);

    if (relation === null || !relation.ahead) {
      continue;
    }

    if (nearest === null || relation.distance < nearest) {
      nearest = relation.distance;
    }
  }

  return nearest;
}
