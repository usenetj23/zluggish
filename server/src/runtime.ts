import { Effect, Schema, Scope } from 'effect';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { makeAppRuntime } from '#src/layers';
import { Resources } from '#src/node/lifecycle/resources';
import { CheckpointRepository } from '#src/repositories/checkpoint.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import type { Bridge } from '#src/services/chat-bridge.service';
import { DiscordService } from '#src/services/discord.service';
import { DurabilityService } from '#src/services/durability.service';
import { JobsService } from '#src/services/jobs.service';
import { MatrixService } from '#src/services/matrix.service';
import { MetricsService } from '#src/services/metrics.service';
import { ImportsService } from '#src/services/profile-import.service';
import { BackupService } from '#src/services/backup.service';
import { TlsService } from '#src/services/tls.service';
import { RetentionService } from '#src/services/retention.service';
import { RideCompletionService } from '#src/services/ride-completion.service';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { UploadsService } from '#src/services/uploads.service';
import { VoiceService } from '#src/services/voice.service';
import { loadWad } from '#src/world/wad';
import { indexWadWorkouts } from '#src/world/wadplan';
import { tailZwiftLog, tailZwiftLogOverHttp } from '#src/world/zwiftlog';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';

const tokensSchema = Schema.Struct({ access: Schema.String, refresh: Schema.String, id: Schema.String });

/** Release with a plain cleanup function, which may be async. */
const releasing = (dispose: () => void | Promise<void>): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await dispose();
    }),
  );

/** A chat bridge that starts, or a warning when its configuration fails: local riding stays available. */
const optionalBridge = (world: World, name: string, start: Effect.Effect<Bridge>) =>
  start.pipe(
    Effect.map((bridge): Bridge[] => [bridge]),
    Effect.catchCause(() =>
      Effect.sync((): Bridge[] => {
        world.lifecycle.log.warn(
          `${name.toLowerCase()}.configuration_failed`,
          `${name} configuration failed; local riding remains available`,
        );

        return [];
      }),
    ),
  );

/** Acquire the server runtime into the current scope. Closing the scope releases everything in reverse
order: background work stops before the final flush, and the storage lock goes last.
*/
const acquireRuntime = Effect.fn('runtime.acquire')(function* (
  config: ResolvedConfig,
  assets: string,
  configPath?: string,
) {
  const release = yield* Effect.promise(() => new LockRepository().acquireStorageLock(config.storageDir));
  yield* releasing(release);

  const accounts = yield* Effect.acquireRelease(
    Effect.sync(() => AccountsService.open(config.storageDir)),
    (opened) => Effect.sync(() => opened.close()),
  );

  const settings = accounts.repositories.settingsRepository;
  yield* releasing(() => settings.close());
  const world = new World();

  const context: RepositoryContext = {
    config,
    assets,
    configPath,
    accounts,
    sessions: SessionsService.open(accounts),
    profiles: accounts.repositories.profileRepository,
    settings,
    world,
    tokens: Schema.decodeUnknownSync(tokensSchema)(
      JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')),
    ),
  };

  const effects = yield* Effect.acquireRelease(
    Effect.sync(() => makeAppRuntime(context)),
    (opened) => Effect.promise(() => opened.dispose()),
  );

  const runtime: Runtime = Object.assign(context, { effects });
  yield* effects.runSync(ImportsService).recover();

  // Chat bubbles of the game reach the rider's voice clients.
  const voice = effects.runSync(VoiceService);

  world.chatObserver = (update, recipients) => effects.runSync(voice.onSocial(update, recipients));

  // The client log says what the screen shows even for the workout library bundled in the game, which never passes
  // this server. ZWIFT_LOG_URL points at a helper on the host, for a log that a container mounts too slowly to follow.
  const onZwiftLine = (line: string) => effects.runSync(voice.onZwiftLine(line));

  yield* releasing(
    process.env.ZWIFT_LOG_URL
      ? tailZwiftLogOverHttp(process.env.ZWIFT_LOG_URL, onZwiftLine)
      : tailZwiftLog(process.env.ZWIFT_LOG ?? '/zwift-logs/Log.txt', onZwiftLine),
  );

  // The game's own workout archive names those log ids and carries the on-screen captions.
  // The archive is optional: one the game changed or damaged only costs the narration of its library workouts.
  try {
    const wad = loadWad(process.env.ZWIFT_WAD ?? '/zwift-assets/workouts.wad');

    if (wad) effects.runSync(voice.setWadWorkouts(indexWadWorkouts(wad)));
  } catch (error) {
    world.lifecycle.log.warn('voice.wad_failed', 'The workout archive of the game could not be read', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const simulation = new Simulation(runtime);
  const checkpoints = new CheckpointRepository(accounts.db, resolve(config.storageDir, 'zluggish.db'));
  yield* releasing(() => checkpoints.close());

  // Stops after the job runner and the simulation: the last flush covers their commits.
  const durability = effects.runSync(DurabilityService);
  yield* Effect.addFinalizer(() => durability.close());
  yield* releasing(async () => {
    await Promise.all((runtime.bridges ?? []).map((bridge) => bridge.close()));
  });
  const jobs = effects.runSync(JobsService);
  yield* Effect.addFinalizer(() => jobs.close());
  yield* releasing(() => simulation.close());
  const recovery = effects.runSync(RideRecoveryService);
  yield* Effect.addFinalizer(() => recovery.close());
  yield* releasing(() => world.lifecycle.close());
  const stopMetrics = yield* effects.runSync(MetricsService).start(config.logging.metricsIntervalSeconds);
  yield* releasing(stopMetrics);

  yield* Effect.promise(() => simulation.ready);
  simulation.start();

  // Ride completion permissions expire on a one-second sweep.
  yield* Effect.sleep(1000).pipe(
    Effect.andThen(effects.runSync(RideCompletionService).sweep()),
    Effect.forever,
    Effect.forkScoped,
  );

  yield* effects.runSync(TlsService).start();
  yield* durability.start();
  yield* recovery.start();
  yield* effects.runSync(UploadsService).start();
  yield* effects.runSync(RetentionService).schedule();
  yield* effects.runSync(BackupService).schedule();
  yield* jobs.start();
  checkpoints.start();

  const bridges = [
    ...(config.integrations.discord.enabled
      ? yield* optionalBridge(world, 'Discord', effects.runSync(DiscordService).start())
      : []),
    ...(config.integrations.matrix.enabled
      ? yield* optionalBridge(world, 'Matrix', effects.runSync(MatrixService).start())
      : []),
  ];

  runtime.bridges = bridges;

  if (bridges.length > 0)
    world.presence = (id, joining) => {
      for (const bridge of bridges) bridge.online(id, joining);
    };

  return runtime;
});

/** Open the server runtime. Close releases it once, however often it is called; a failed open releases
what it acquired before it rejects.
*/
export async function openRuntime(config: ResolvedConfig, assets: string, configPath?: string) {
  const resources = new Resources();

  try {
    const runtime = await Effect.runPromise(
      acquireRuntime(config, assets, configPath).pipe(Scope.provide(resources.scope)),
    );

    return { runtime, close: () => resources.close() };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed', {
        cause: cleanupError,
      });
    }

    throw error;
  }
}
