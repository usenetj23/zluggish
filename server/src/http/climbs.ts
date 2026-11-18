import { climbSchema } from '#src/dtos/accounts.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { resolve } from 'node:path';
import { z } from 'zod';

const climbSegments = z.record(
  z.string(),
  z.object({ watopia: z.number().int().positive(), france: z.number().int().positive() }),
);

/** The Strava segments of a climb portal road: the climb as ridden from Watopia and from France, by road. */
export function readClimbSegments(runtime: HttpRuntime) {
  return climbSegments.parse(
    JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climb_segments.txt'), 'utf8')),
  );
}

/** The climb portal roads the launcher offers, with their display names. */
export function readClimbs(runtime: HttpRuntime) {
  return z
    .array(climbSchema)
    .parse(JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climbs.txt'), 'utf8')));
}
