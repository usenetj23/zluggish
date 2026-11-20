import { WorkoutsService } from '#src/services/workout.service';
import { Effect } from 'effect';
import { VoiceService } from '#src/services/voice.service';
import { parsePlan } from '#src/world/zwo';
import { effectRoutes } from '#src/http/effect';
import { FilesService } from '#src/services/files.service';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
The riders a workout file is read to: the one who asked or, when the request carries no identity, the only rider who
is online. With several riders online nobody is guessed, so a plan is never read to the wrong one.
*/
function listeners(asker: number | null, online: readonly number[]) {
  if (asker !== null) return [asker];

  return online.length === 1 ? online : [];
}

export function workoutRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  const selected = Effect.fn('workouts.selected')(function* (id: number, sport?: string) {
    const workouts = yield* WorkoutsService;

    return sport === undefined || sport.toUpperCase() === 'CYCLING' ? yield* workouts.list(id) : [];
  });

  appRoutes.get('/api/workout/schedule/list', (c) =>
    Effect.gen(function* () {
      const user = authenticated(c);
      c.header('Cache-Control', 'private, no-store');

      return c.json((yield* selected(user.player_id, c.req.query('sport'))).map((item) => item.schedule));
    }),
  );
  appRoutes.get('/api/head-unit-bff/game-home', (c) =>
    Effect.gen(function* () {
      const user = authenticated(c);
      c.header('Cache-Control', 'private, no-store');

      return c.json((yield* selected(user.player_id, c.req.query('sport')))[0]?.home ?? {});
    }),
  );
  appRoutes.get('/api/head-unit-bff/carousels/for-you', (c) =>
    Effect.gen(function* () {
      const user = authenticated(c);
      c.header('Cache-Control', 'private, no-store');

      return c.json(
        (yield* selected(user.player_id, c.req.query('sport'))).map((workout) => ({
          recommendationType: 'workout',
          workoutUUID: workout.id,
          workoutHash: null,
          assetUrl: workout.schedule.workoutUri,
          providerId: 'intervalsicu',
          provider: null,
          scheduleId: workout.schedule.scheduleId,
          score: 1,
          explanation: null,
          sourceData: null,
          source: 'SCHEDULED',
          sourceId: workout.schedule.scheduleId,
          ribbon: null,
          recommendedDurationMinutes: null,
        })),
      );
    }),
  );
  appRoutes.get('/api/workout/workouts/:id', (c) =>
    Effect.gen(function* () {
      const user = authenticated(c);

      const workout = (yield* selected(user.player_id, c.req.query('sport'))).find(
        (item) => item.id === c.req.param('id'),
      );

      if (!workout) {
        throw new HTTPException(404);
      }
      c.header('Cache-Control', 'private, no-store');

      return c.json(workout.schedule.workoutSummary);
    }),
  );
  appRoutes.get('/tp-workouts/intervalsicu/:id', (c) =>
    Effect.gen(function* () {
      const workoutsService = yield* WorkoutsService;

      const filesService = yield* FilesService;

      const file = yield* workoutsService.file(c.req.param('id').replace(/\.zwo$/, ''));

      if (!file || !(yield* filesService.exists(file))) {
        throw new HTTPException(404);
      }

      const content = yield* filesService.read(file);

      // The game asks for the plan when the workout starts; the voice reads it and its blocks aloud. The voice is an extra:
      // whatever goes wrong in it never keeps the workout file from the game.
      yield* Effect.gen(function* () {
        const plan = parsePlan(content.toString());

        if (!plan) return;

        const voiceService = yield* VoiceService;
        const online = runtime.world.online.keys().toArray().map(Number);

        for (const player of listeners(c.get('user')?.player_id ?? null, online))
          yield* voiceService.onWorkout(player, plan);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            runtime.world.lifecycle.log.warn('voice.workout_failed', 'The workout could not be read aloud', {
              error: String(cause),
            }),
          ),
        ),
      );

      return c.body(content, 200, {
        'Content-Type': 'application/xml',
      });
    }),
  );
  app.get('/api/assetcms/*', (c) =>
    c.json(c.req.path.endsWith('/partner_name_map.json/download') ? { intervalsicu: 'Intervals.icu' } : null),
  );
}
