import type { RepositoryContext } from '#src/context';
import { SegmentResultSchema } from '#src/protocol/generated/segment-result_pb';
import { RecordsRepository } from '#src/repositories/records.repository';
import { AchievementService } from '#src/services/achievement.service';
import { BaseService } from '#src/services/base.service';

export class RecordsService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  updateRouteResult(...values: Parameters<RecordsRepository['updateRouteResult']>) {
    return this.recordsRepository.updateRouteResult(...values);
  }

  listRouteResult(...values: Parameters<RecordsRepository['listRouteResult']>) {
    return this.recordsRepository.listRouteResult(...values);
  }

  riddenClimbRoads(...values: Parameters<RecordsRepository['riddenClimbRoads']>) {
    return this.recordsRepository.riddenClimbRoads(...values);
  }

  climbPortalStats(...values: Parameters<RecordsRepository['climbPortalStats']>) {
    return this.recordsRepository.climbPortalStats(...values);
  }

  findPrivateEvent(...values: Parameters<RecordsRepository['findPrivateEvent']>) {
    return this.recordsRepository.findPrivateEvent(...values);
  }

  mine(playerId: number, sport?: string, segment?: string) {
    return this.recordsRepository
      .riderSegments(
        BigInt(playerId),
        segment === undefined ? null : BigInt(segment),
        sport === undefined ? null : sport === 'RUNNING' ? 1 : 0,
      )
      .map((row) => this.protobufRepository.decode(SegmentResultSchema, row));
  }

  segmentLeaderboard(...values: Parameters<RecordsRepository['segmentLeaderboard']>) {
    return this.recordsRepository.segmentLeaderboard(...values);
  }

  backfillRoutes(id: number) {
    return new AchievementService(this.repositories).backfillRoutes(this.context, id);
  }
}
