import { climbSchema } from '#src/dtos/accounts.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { resolve } from 'node:path';
import { z } from 'zod';

/** The climb portal roads the launcher offers, with their display names. */
export function readClimbs(runtime: HttpRuntime) {
  return z
    .array(climbSchema)
    .parse(JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climbs.txt'), 'utf8')));
}
