import { query, SqliteExecutor } from '#src/db/query';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const climbRideRowSchema = Schema.Struct({
  activity_id: Schema.NullOr(Schema.Finite),
  elapsed_ms: Schema.NullOr(Schema.Finite),
  world_time: Schema.NullOr(Schema.Finite),
  strava_activity_id: Schema.NullOr(Schema.Union([Schema.Finite, Schema.BigInt])),
});

const activityRangeRowSchema = Schema.Struct({
  id: Schema.Finite,
  start_date: Schema.String,
  end_date: Schema.String,
  strava_activity_id: Schema.NullOr(Schema.Union([Schema.Finite, Schema.BigInt])),
});

export class RecordsRepository {
  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  updateRouteResult(player: number, id: number | bigint) {
    return this.executor.run(query.updateTable('route_result').set({ player_id: player }).where('id', '=', id));
  }

  listRouteResult(player: number) {
    return this.executor.all(
      query
        .selectFrom('route_result')
        .select('route_hash')
        .select(({ fn }) => [fn.min('world_time').as('first'), fn.max('world_time').as('last')])
        .where('player_id', '=', player)
        .groupBy('route_hash'),
    );
  }

  findPrivateEvent(id: number | bigint) {
    return this.executor.get(query.selectFrom('private_event').select('json').where('id', '=', id));
  }

  routeBadgeCount(player: number) {
    return (
      this.executor.get(
        query
          .selectFrom('route_result')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('player_id', '=', player)
          .where('route_hash', '>=', 10_000)
          .where('route_hash', '<=', 11_000),
      )?.count ?? 0
    );
  }

  /** Climb portal roads (route hashes 10,000 to 11,000) this rider has already ridden. */
  riddenClimbRoads(player: number) {
    return this.executor
      .all(
        query
          .selectFrom('route_result')
          .select('route_hash')
          .distinct()
          .where('player_id', '=', player)
          .where('route_hash', '>=', 10_000)
          .where('route_hash', '<=', 11_000),
      )
      .map((row) => String(row.route_hash));
  }

  /** Per climb portal road this rider has ridden: how often, the fastest time and the latest world time. */
  climbPortalStats(player: number) {
    return this.executor.all(
      query
        .selectFrom('route_result')
        .select('route_hash')
        .select(({ fn }) => [
          fn.countAll<number>().as('rides'),
          fn.min('elapsed_ms').filterWhere('elapsed_ms', '>', 0).as('best_ms'),
          fn.max('world_time').as('last_world_time'),
        ])
        .where('player_id', '=', player)
        .where('route_hash', '>=', 10_000)
        .where('route_hash', '<=', 11_000)
        .groupBy('route_hash'),
    );
  }

  ensureRoute(player: number, hash: number) {
    const existing = this.executor.get(
      query.selectFrom('route_result').select('id').where('player_id', '=', player).where('route_hash', '=', hash),
    );

    if (!existing) this.executor.run(query.insertInto('route_result').values({ player_id: player, route_hash: hash }));
  }

  /** Fastest results first, for one segment when given, since a world time when given. */
  segmentLeaderboard(segment: bigint | null, since: bigint | null) {
    let selection = query.selectFrom('segment_result').selectAll();

    if (segment !== null) selection = selection.where('segment_id', '=', segment);

    if (since !== null) selection = selection.where('world_time', '>', since);

    return this.executor.all(selection.orderBy('elapsed_ms'), true);
  }

  /** One rider's results, optionally for one segment and sport. */
  riderSegments(player: bigint, segment: bigint | null, sport: number | null) {
    let selection = query.selectFrom('segment_result').selectAll().where('player_id', '=', player);

    if (segment !== null) selection = selection.where('segment_id', '=', segment);

    // A missing sport decodes as cycling (0), as the protobuf default.
    if (sport !== null) selection = selection.where(sql<number>`coalesce(sport, 0)`, '=', sport);

    return this.executor.all(selection.orderBy('id'), true);
  }

  /** All route_result rows of a player for one climb road, LEFT JOINed to activity for strava_activity_id. */
  climbRides(player: number, road: number) {
    const rows = this.executor.all(
      query
        .selectFrom('route_result')
        .leftJoin('activity', (join) =>
          join
            .onRef('activity.id', '=', 'route_result.activity_id')
            .onRef('activity.player_id', '=', 'route_result.player_id'),
        )
        .select([
          'route_result.activity_id',
          'route_result.elapsed_ms',
          'route_result.world_time',
          'activity.strava_activity_id',
        ])
        .where('route_result.player_id', '=', player)
        .where('route_result.route_hash', '=', road)
        .orderBy('route_result.world_time', 'desc')
        .limit(500),
    );

    return rows.map((row) => Schema.decodeUnknownSync(climbRideRowSchema)(row));
  }

  /** The player's activities newest first as time ranges, for resolving climb rides without activity_id. */
  activityRanges(player: number) {
    const rows = this.executor.all(
      query
        .selectFrom('activity')
        .select(['id', 'start_date', 'end_date', 'strava_activity_id'])
        .where('player_id', '=', player)
        .where('start_date', 'is not', null)
        .where('end_date', 'is not', null)
        .orderBy('start_date', 'desc')
        .limit(2000),
    );

    const results: Array<{ id: number; startMs: number; endMs: number; stravaActivityId: number | bigint | null }> = [];

    for (const raw of rows) {
      const parsed = Schema.decodeUnknownSync(activityRangeRowSchema)(raw);
      const startMs = Date.parse(parsed.start_date);
      const endMs = Date.parse(parsed.end_date);

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      results.push({ id: parsed.id, startMs, endMs, stravaActivityId: parsed.strava_activity_id });
    }

    return results;
  }
}
