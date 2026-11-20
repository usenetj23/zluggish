import { RuntimeContext } from '#src/context';
import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import { parseClimbEfforts } from '#src/world/climb-efforts';
import type { Effort } from '#src/world/climb-efforts';
import { parseClimbProfiles } from '#src/world/climb-profile';
import type { ClimbFacts } from '#src/world/climb-ride';
import { climbProfileOf, locateClimb, mergeEffort, mergeProfile, rideStats } from '#src/world/climb-ride';
import { WORLD_TIME_EPOCH_MS } from '#src/world/state';
import { Context, Effect, Layer } from 'effect';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;

  return {
    /**
    Learns the climb portal rides of a finished activity from its recording: when and how long and with what power the
    rider rode them, and the profile of a climb that has none yet. The results are the rider's documents
    climb_efforts.json and climb_profiles.json.
    */
    record: Effect.fn('ClimbRecorderService.record')(function* (
      player: number,
      activity: number,
      climbs: ReadonlyMap<string, ClimbFacts>,
    ) {
      const stored = repositories.activitiesRepository.fit(activity);

      if (!stored || stored.player !== player || !stored.fit?.length) return 0;

      const results = repositories.recordsRepository
        .climbResultsOfActivity(player, activity)
        .filter((row) => climbs.has(String(row.route_hash)) && row.world_time !== null && (row.elapsed_ms ?? 0) > 0);

      if (results.length === 0) return 0;

      const { records } = new FitDecoder().decode(stored.fit);
      const effortsText = repositories.riderDocuments.text(player, 'climb_efforts.json') ?? '';
      const profilesText = repositories.riderDocuments.text(player, 'climb_profiles.json') ?? '';

      let efforts: Readonly<Record<string, ReadonlyArray<Effort>>> = parseClimbEfforts(effortsText);

      let profiles = parseClimbProfiles(profilesText);

      let learned = 0;

      for (const row of results) {
        const road = String(row.route_hash);
        const facts = climbs.get(road);

        if (!facts || row.world_time === null || row.elapsed_ms === null) continue;

        const finishS = (row.world_time + WORLD_TIME_EPOCH_MS) / 1000;
        const window = locateClimb(records, finishS, row.elapsed_ms / 1000, facts.distanceM);

        if (!window) continue;

        const stretch = records.slice(window.from, window.to + 1);
        const effort = rideStats(stretch);

        if (!effort) continue;

        efforts = mergeEffort(efforts, road, effort);
        learned += 1;
        const profile = climbProfileOf(stretch, facts);

        if (profile) profiles = mergeProfile(profiles, road, profile);
      }

      if (learned > 0) {
        repositories.riderDocuments.put(player, 'climb_efforts.json', JSON.stringify(efforts));
        repositories.riderDocuments.put(player, 'climb_profiles.json', JSON.stringify(profiles));
      }

      return learned;
    }),
  };
});

/** Learns climb ride efforts and profiles from activity recordings. */
export class ClimbRecorderService extends Context.Service<ClimbRecorderService, Effect.Success<typeof make>>()(
  'zluggish/ClimbRecorderService',
) {
  static readonly layer = Layer.effect(ClimbRecorderService, make);
}
