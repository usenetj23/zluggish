import { FilesService } from '#src/services/files.service';
import { ProfilesService } from '#src/services/profile.service';
import { DocumentsService } from '#src/services/documents.service';
import { RecordDataService } from '#src/services/record-data.service';
import { effectRoutes } from '#src/http/effect';
import { RecordsService } from '#src/services/records.service';
import { learnClimbs } from '#src/http/climbs';
import { routeCompletionStatsSchema, meetupStartSchema } from '#src/dtos/records.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { RaceResultEntrySaveRequest } from '#src/protocol/generated/race-result_pb';
import {
  RaceResultEntryProfileDataSchema,
  RaceResultEntrySaveRequestSchema,
  RaceResultEntrySchema,
  RaceResultSummarySchema,
} from '#src/protocol/generated/race-result_pb';
import {
  LoadPlayerRouteCompletionAchievementsResponseSchema,
  RouteCompletionAchievementUnlockRequestSchema,
} from '#src/protocol/generated/route-completion-achievement_pb';
import { RouteResultSaveRequestSchema } from '#src/protocol/generated/route-result_pb';
import type { SegmentResult } from '#src/protocol/generated/segment-result_pb';
import {
  SegmentResultSchema,
  SegmentResultsSchema,
  SegmentRideStatsSchema,
} from '#src/protocol/generated/segment-result_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { course, worldTime } from '#src/world/state';
import { clearField, clone, create, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { NumberFromInput } from '#src/schema';

const timestamp = (value: number | null) => (value ? new Date(value + 1_414_016_075_000).toISOString() : '');

const fastest = (results: SegmentResult[]) => [...results].sort((a, b) => Number(a.elapsedMs - b.elapsedMs));

function resultJSON(result: SegmentResult, count: number) {
  return {
    segmentId: Number(result.segmentId),
    profileId: Number(result.playerId),
    firstInitial: result.firstName[0] ?? '',
    lastName: result.lastName,
    endTime: Date.parse(result.finishTimeStr),
    durationInMilliseconds: Number(result.elapsedMs),
    playerType: 'NORMAL',
    activityId: Number(result.activityId),
    numberOfResults: count,
  };
}

export function recordRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  // Absent -> accumulating by subgroup/rider -> pruned on a later POST after one hour. GET is observational.
  const races = new Map<bigint, { touched: number; riders: Map<number, RaceResultEntrySaveRequest> }>();

  appRoutes.post('/api/segment-results', (c) =>
    Effect.gen(function* () {
      const recordDataService = yield* RecordDataService;

      const user = authenticated(c);
      const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
      const result = parseProtobuf(SegmentResultSchema, bytes);

      if (result.segmentId === 1n) throw new HTTPException(400);
      result.playerId = BigInt(user.player_id);
      result.worldTime = worldTime();
      result.finishTimeStr = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      result.id = BigInt(yield* recordDataService.insert('segment_result', SegmentResultSchema, result));
      const sender = runtime.world.online.get(result.playerId);

      if (sender)
        runtime.world.enqueue(
          create(WorldAttributeSchema, {
            serverRealm: 1n,
            waType: WA_TYPE.WAT_SR,
            payload: toBinary(SegmentResultSchema, result),
            worldTimeBorn: worldTime(),
            worldTimeExpire: worldTime() + 60_000n,
            timestamp: BigInt(Date.now()) * 1000n,
          }),
          [...runtime.world.online].flatMap(([id, state]) =>
            id !== result.playerId && (course(sender) === course(state) || state.watchingRiderId === result.playerId)
              ? id
              : [],
          ),
        );

      return c.json({ id: Number(result.id) });
    }),
  );
  appRoutes.get('/api/personal-records/my-records', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const user = authenticated(c);
      const segment = c.req.query('segmentId');

      if (!segment) throw new HTTPException(422);
      const from = c.req.query('from');
      const to = c.req.query('to');

      const results = fastest(
        (yield* recordsService.mine(user.player_id, undefined, segment)).filter(
          (item) =>
            (!from || runtime.config.leaderboards.allTime || Date.parse(item.finishTimeStr) > Date.parse(from)) &&
            (!to || Date.parse(item.finishTimeStr) < Date.parse(to)),
        ),
      ).slice(0, 100);

      for (const result of results)
        for (const field of [
          'serverRealm',
          'courseId',
          'segmentId',
          'eventSubgroupId',
          'finishTimeStr',
          'f14',
          'time',
          'playerType',
          'f22',
          'f23',
        ]) {
          const descriptor = SegmentResultSchema.fields.find((item) => item.localName === field);

          if (descriptor) clearField(result, descriptor);
        }

      return c.body(
        toBinary(
          SegmentResultsSchema,
          create(SegmentResultsSchema, {
            serverRealm: 1n,
            segmentId: BigInt(segment),
            segmentResults: results,
          }),
        ),
      );
    }),
  );
  appRoutes.get('/api/personal-records/my-segment-ride-stats/:sport', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const user = authenticated(c);
      const segment = c.req.query('segmentId');

      if (!segment) throw new HTTPException(422);

      const results = yield* recordsService.mine(user.player_id, c.req.param('sport'), segment);
      const best = fastest(results)[0];
      const latest = [...results].sort((a, b) => Number(b.worldTime - a.worldTime) || Number(b.id - a.id))[0];

      const stats = create(SegmentRideStatsSchema, {
        segmentId: BigInt(segment),
      });

      if (best && latest) {
        stats.numberOfResults = results.length;
        stats.latestTime = latest.elapsedMs;
        stats.bestTime = best.elapsedMs;
        stats.latestPercentile = 100;
        stats.bestPercentile = 100;
      }

      return c.body(toBinary(SegmentRideStatsSchema, stats));
    }),
  );
  appRoutes.get('/api/personal-records/results/summary/profiles/me/:sport', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const user = authenticated(c);
      const sport = c.req.param('sport');
      const segments = c.req.queries('segmentIds') ?? [];

      return c.json({
        query: {
          name: 'AllTimeBestResultsForSegments',
          labelsAre: 'SEGMENT_ID',
          sport,
          segmentIds: segments,
        },
        results: (yield* Effect.forEach(segments, (segment) =>
          recordsService.mine(user.player_id, sport, segment).pipe(
            Effect.map((rows) => {
              const results = fastest(rows);

              return results[0] ? [{ label: segment, result: resultJSON(results[0], results.length) }] : [];
            }),
          ),
        )).flat(),
      });
    }),
  );
  appRoutes.get('/api/personal-records/results/summary/profiles/me/:sport/segments/:segment/by-quarter', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const user = authenticated(c);
      const { sport, segment } = c.req.param();
      const quarters = new Map<string, SegmentResult[]>();

      for (const result of yield* recordsService.mine(user.player_id, sport, segment)) {
        const date = new Date(result.finishTimeStr);
        const key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
        const entries = quarters.get(key) ?? [];
        entries.push(result);
        quarters.set(key, entries);
      }

      return c.json({
        query: {
          name: 'QuarterlyRecordsForSegment',
          labelsAre: 'YEAR-QUARTER',
          sport,
          segmentId: segment,
        },
        results: [...quarters]
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([label, items]) => {
            const best = fastest(items)[0];

            return best ? { label, result: resultJSON(best, items.length) } : [];
          }),
      });
    }),
  );
  appRoutes.get(
    '/api/personal-records/results/summary/profiles/me/:sport/segments/:segment/date/:year/:quarter/all',
    (c) =>
      Effect.gen(function* () {
        const recordsService = yield* RecordsService;

        const user = authenticated(c);
        const { sport, segment, year, quarter } = c.req.param();

        const results = (yield* recordsService.mine(user.player_id, sport, segment)).filter((result) => {
          const date = new Date(result.finishTimeStr);

          return (
            date.getUTCFullYear() === Number(year) &&
            Math.floor(date.getUTCMonth() / 3) + 1 === Number(quarter.replace('Q', ''))
          );
        });

        return c.json({
          query: {
            name: 'AllResultsInQuarterForSegment',
            labelsAre: 'END_TIME',
            sport,
            segmentId: segment,
            year,
            quarter,
          },
          results: results.map((result) => ({
            label: String(Date.parse(result.finishTimeStr)),
            result: resultJSON(result, 1),
          })),
        });
      }),
  );
  appRoutes.on(
    'GET',
    ['/live-segment-results-service/leaders', '/live-segment-results-service/leaderboard/:segment'],
    (c) =>
      Effect.gen(function* () {
        const recordDataService = yield* RecordDataService;

        const recordsService = yield* RecordsService;

        const segment = c.req.path.split('/', 4)[3];

        const best = new Map<string, SegmentResult>();

        const since = runtime.config.leaderboards.allTime ? null : worldTime() - 3_600_000n;

        for (const row of yield* recordsService.segmentLeaderboard(segment ? BigInt(segment) : null, since)) {
          const result = yield* recordDataService.decode(SegmentResultSchema, row);
          const key = `${result.segmentId}:${result.playerId}`;

          if (best.has(key)) continue;

          if (runtime.config.leaderboards.allTime && result.worldTime <= worldTime() - 3_600_000n) {
            result.playerId += 100_000n;
            result.worldTime = worldTime();
          }

          best.set(key, result);
        }

        return c.body(
          toBinary(
            SegmentResultsSchema,
            create(SegmentResultsSchema, {
              serverRealm: 0n,
              segmentId: BigInt(segment || 0),
              segmentResults: best.values().take(100).toArray(),
            }),
          ),
        );
      }),
  );

  appRoutes.post('/api/route-results', (c) =>
    Effect.gen(function* () {
      const recordDataService = yield* RecordDataService;

      const recordsService = yield* RecordsService;

      const user = authenticated(c);

      const result = parseProtobuf(
        RouteResultSaveRequestSchema,
        new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
      );

      const id = yield* recordDataService.insert('route_result', RouteResultSaveRequestSchema, result);

      yield* recordsService.updateRouteResult(user.player_id, id);

      // The ride just finished is in the recording of its activity: learn how it went. A failure never reaches the game.
      if (result.activityId > 0n) yield* learnClimbs(runtime, user.player_id, Number(result.activityId));

      return c.body(null, 202);
    }),
  );
  appRoutes.get('/api/route-results/completion-stats/all', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const user = authenticated(c);

      const page = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))(
        c.req.query('page') ?? 0,
      );

      const size = Schema.decodeUnknownSync(
        NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
      )(c.req.query('pageSize') ?? 100);

      yield* recordsService.backfillRoutes(user.player_id);

      const rows = yield* recordsService.listRouteResult(user.player_id);

      const stats = rows.map((row) => {
        const item = Schema.decodeUnknownSync(routeCompletionStatsSchema)(row);

        return {
          routeHash: item.route_hash,
          firstCompletedAt: timestamp(item.first),
          lastCompletedAt: timestamp(item.last),
        };
      });

      const pageCount = Math.ceil(stats.length / size);

      return c.json({
        response: { stats: stats.slice(page * size, (page + 1) * size) },
        hasPreviousPage: page > 0,
        hasNextPage: page < pageCount - 1,
        pageCount,
      });
    }),
  );

  appRoutes.get('/api/achievement/route-completion-achievements', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const documentsService = yield* DocumentsService;

      const user = authenticated(c);

      const response = fromJsonString(
        LoadPlayerRouteCompletionAchievementsResponseSchema,
        yield* filesService.readText(resolve(runtime.assets, 'data/route_completion_achievement.txt')),
      );

      const stored = yield* documentsService.get(user.player_id, 'route_completion_achievements.bin');

      const unlocked = stored ? fromBinary(RouteCompletionAchievementUnlockRequestSchema, stored).achievementUuids : [];

      for (const achievement of response.achievements)
        if (unlocked.includes(achievement.achievementUuid)) achievement.unlocked = true;

      return c.body(toBinary(LoadPlayerRouteCompletionAchievementsResponseSchema, response));
    }),
  );
  appRoutes.post('/api/achievement/route-completion-achievement-unlocks', (c) =>
    Effect.gen(function* () {
      const documentsService = yield* DocumentsService;

      const user = authenticated(c);

      const incoming = parseProtobuf(
        RouteCompletionAchievementUnlockRequestSchema,
        new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
      );

      const stored = yield* documentsService.get(user.player_id, 'route_completion_achievements.bin');

      const old = stored
        ? fromBinary(RouteCompletionAchievementUnlockRequestSchema, stored)
        : create(RouteCompletionAchievementUnlockRequestSchema);

      old.achievementUuids = [...new Set([...old.achievementUuids, ...incoming.achievementUuids])];
      yield* documentsService.put(
        user.player_id,
        'route_completion_achievements.bin',
        toBinary(RouteCompletionAchievementUnlockRequestSchema, old),
      );

      return c.body(null, 202);
    }),
  );
  app.post('/api/race-results', async (c) => {
    const user = authenticated(c);

    const result = parseProtobuf(RaceResultEntrySaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    for (const [id, race] of races) if (Date.now() - race.touched > 3_600_000) races.delete(id);

    const race = races.get(result.eventSubgroupId) ?? {
      touched: 0,
      riders: new Map(),
    };

    race.touched = Date.now();
    race.riders.set(user.player_id, result);
    races.set(result.eventSubgroupId, race);

    return c.body(null, 202);
  });
  appRoutes.get('/api/race-results/summary', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const profilesService = yield* ProfilesService;

      const recordsService = yield* RecordsService;

      authenticated(c);
      const id = BigInt(c.req.query('event_subgroup_id') ?? '0');

      const meetup = yield* recordsService.findPrivateEvent(id);

      const sorted = [...(races.get(id)?.riders ?? [])].sort(([, a], [, b]) =>
        Number((a.activityData?.worldTime ?? 0n) - (b.activityData?.worldTime ?? 0n)),
      );

      const entries = yield* Effect.forEach(sorted, ([playerId, result], index) =>
        Effect.gen(function* () {
          const profile = yield* profilesService.get(playerId);

          const entry = create(RaceResultEntrySchema, {
            playerId: BigInt(playerId),
            eventSubgroupId: id,
            position: index + 1,
            eventId: id,
            activityData: result.activityData ? { ...result.activityData } : undefined,
            powerData: result.powerData,
            sensorData: result.sensorData,
            profileData: create(RaceResultEntryProfileDataSchema, {
              weightInGrams: profile.weightInGrams,
              heightInCentimeters: Math.floor(profile.heightInMillimeters / 10),
              gender: profile.isMale ? 1 : 2,
              playerType: profile.playerType,
              firstName: profile.firstName,
              lastName: profile.lastName,
              avatarUrl: (yield* filesService.exists(
                resolve(yield* profilesService.folder(playerId), 'avatarLarge.jpg'),
              ))
                ? `https://us-or-rly101.zwift.com/download/${playerId}/avatarLarge.jpg`
                : '',
            }),
          });

          if (entry.activityData) {
            entry.activityData.time = entry.activityData.worldTime + 1_414_016_074_397n;

            if (meetup) {
              const { eventStart } = Schema.decodeUnknownSync(meetupStartSchema)(
                JSON.parse(Schema.decodeUnknownSync(Schema.String)(meetup.json)),
              );

              entry.activityData.elapsedMs = entry.activityData.time - BigInt(Date.parse(eventStart));
            }

            entry.time = entry.activityData.time;
            entry.distanceToLeader = Number(
              entry.activityData.worldTime - (sorted[0]?.[1].activityData?.worldTime ?? 0n),
            );
          }

          return clone(RaceResultEntrySchema, entry);
        }),
      );

      return c.body(
        toBinary(
          RaceResultSummarySchema,
          create(RaceResultSummarySchema, {
            f1: entries,
            f2: entries,
            total: entries.length,
          }),
        ),
      );
    }),
  );
}
