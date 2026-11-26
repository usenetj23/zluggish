import { RuntimeContext } from '#src/context';
import { SegmentResultSchema } from '#src/protocol/generated/segment-result_pb';
import { AchievementService } from '#src/services/achievement.service';
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
  };
});

export class RecordsService extends Context.Service<RecordsService, Effect.Success<typeof make>>()(
  'zluggish/RecordsService',
) {
  static readonly layer = Layer.effect(RecordsService, make);
}
