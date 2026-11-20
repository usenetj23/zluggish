import { RuntimeContext } from '#src/context';
import { SegmentResultSchema } from '#src/protocol/generated/segment-result_pb';
import { AchievementService } from '#src/services/achievement.service';
import { activityAt } from '#src/world/activity-at';
import { WORLD_TIME_EPOCH_MS } from '#src/world/state';
import { Context, Effect, Layer } from 'effect';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const achievementService = yield* AchievementService;
  const records = repositories.recordsRepository;

  return {
    updateRouteResult: Effect.fn('RecordsService.updateRouteResult')(function* (player: number, id: number | bigint) {
      return records.updateRouteResult(player, id);
    }),

    listRouteResult: Effect.fn('RecordsService.listRouteResult')(function* (player: number) {
      return records.listRouteResult(player);
    }),

    /** Climb portal roads this rider has already ridden. */
    riddenClimbRoads: Effect.fn('RecordsService.riddenClimbRoads')(function* (player: number) {
      return records.riddenClimbRoads(player);
    }),

    climbPortalStats: Effect.fn('RecordsService.climbPortalStats')(function* (player: number) {
      return records.climbPortalStats(player);
    }),

    findPrivateEvent: Effect.fn('RecordsService.findPrivateEvent')(function* (id: number | bigint) {
      return records.findPrivateEvent(id);
    }),

    /** The rider's segment results, optionally for one sport and one segment. */
    mine: Effect.fn('RecordsService.mine')(function* (playerId: number, sport?: string, segment?: string) {
      return records
        .riderSegments(
          BigInt(playerId),
          segment === undefined ? null : BigInt(segment),
          sport === undefined ? null : sport === 'RUNNING' ? 1 : 0,
        )
        .map((row) => repositories.protobufRepository.decode(SegmentResultSchema, row));
    }),

    segmentLeaderboard: Effect.fn('RecordsService.segmentLeaderboard')(function* (
      segment: bigint | null,
      since: bigint | null,
    ) {
      return records.segmentLeaderboard(segment, since);
    }),

    /** Record route badges the rider already holds as ridden routes. */
    backfillRoutes: Effect.fn('RecordsService.backfillRoutes')(function* (id: number) {
      yield* achievementService.backfillRoutes(id);
    }),

    climbRides: Effect.fn('RecordsService.climbRides')(function* (player: number, road: number) {
      const rows = repositories.recordsRepository.climbRides(player, road);

      const needsResolution = rows.some((r) => r.activity_id === null && r.world_time !== null);
      const ranges = needsResolution ? repositories.recordsRepository.activityRanges(player) : [];

      const resolved = rows.map((row) => {
        if (row.activity_id !== null || row.world_time === null) return row;

        const found = activityAt(row.world_time + WORLD_TIME_EPOCH_MS, ranges);

        if (!found) return row;

        return { ...row, activity_id: found.id, strava_activity_id: row.strava_activity_id ?? found.stravaActivityId };
      });

      const activityIds = resolved.map((r) => r.activity_id).filter((id): id is number => id !== null);
      const allRemote = activityIds.length > 0 ? repositories.uploadsRepository.remoteIds(activityIds, player) : [];

      const withTime = resolved.filter((r) => r.elapsed_ms !== null && r.elapsed_ms > 0);
      const withoutTime = resolved.filter((r) => r.elapsed_ms === null || r.elapsed_ms <= 0);

      withTime.sort((a, b) => {
        if (a.elapsed_ms !== b.elapsed_ms) return (a.elapsed_ms ?? 0) - (b.elapsed_ms ?? 0);

        return (b.world_time ?? 0) - (a.world_time ?? 0);
      });

      withoutTime.sort((a, b) => (b.world_time ?? 0) - (a.world_time ?? 0));

      const sorted = [...withTime, ...withoutTime].slice(0, 50);

      return sorted.map((row) => ({
        activityId: row.activity_id,
        worldTime: row.world_time,
        elapsedMs: row.elapsed_ms,
        stravaActivityId: row.strava_activity_id,
        remote: allRemote
          .filter((r) => r.activity_id === row.activity_id)
          .map(({ provider, remote_id }) => ({ provider, remote_id })),
      }));
    }),
  };
});

/** Route results, segment results and leaderboards. */
export class RecordsService extends Context.Service<RecordsService, Effect.Success<typeof make>>()(
  'zluggish/RecordsService',
) {
  static readonly layer = Layer.effect(RecordsService, make);
}
