import { configSchema } from '#src/config/schema';
import type { Runtime } from '#src/http/runtime';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { GhostSchema, PlayerStateSchema, UserBikeAction } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { SettingsService } from '#src/services/settings.service';
import { Blob } from '#src/world/blob';
import { Random, clamp } from '#src/world/geometry';
import { GestureDirector, gestureUpdate } from '#src/world/gestures';
import type { Templates } from '#src/world/commentary';
import { Commentator, loadTemplates } from '#src/world/commentary';
import type { Jokes } from '#src/world/jokes';
import { JokeTeller, chatUpdate, loadJokes, resolveLanguage } from '#src/world/jokes';
import type { Segment } from '#src/world/segments';
import { loadSegments } from '#src/world/segments';
import type { ReplayRider } from '#src/world/peloton';
import { Peloton } from '#src/world/peloton';
import { RiderPool, ghostAppearanceSchema } from '#src/world/riders';
import { course, forward, road, worldTime } from '#src/world/state';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { botCommand } from '#src/dtos/management.dto';

interface GhostPlayback {
  states: PlayerState[];
  position: number;
  date: bigint;
  id: bigint;
}

/** Loading and playback are independent: manual regroup may precede lazy loading.
Exhaustion is position >= states.length per recording; regroup can revive it.
*/
interface RiderGhosts {
  lastRoadTime: number;
  loading: 'waiting' | 'loading' | 'loaded';
  playback: 'waiting' | 'playing';
  startRoad: number;
  startTime: number;
  last: number;
  playbacks: GhostPlayback[];
}

/** No joke when the last packet of the rider is older than this many seconds: the rider is not riding. */
const JOKE_MAX_STATE_AGE_S = 10;

/** The kind of line a bot says with each hand signal, as named in data/commentary.txt (gesture_<name>). */
const GESTURE_NAMES = new Map([
  [UserBikeAction.UBA_ELBOW, 'elbow'],
  [UserBikeAction.UBA_WAVE, 'wave'],
  [UserBikeAction.UBA_RIDEON, 'rideon'],
  [UserBikeAction.UBA_HAMMER, 'hammer'],
  [UserBikeAction.UBA_NICE, 'nice'],
  [UserBikeAction.UBA_BRING_IT, 'bringit'],
  [UserBikeAction.UBA_TOAST, 'toast'],
  [UserBikeAction.UBA_BELL, 'bell'],
]);

const ahead = (state: PlayerState, time: number) =>
  Math.abs(state.roadTime - time) < 500_000 && (forward(state) ? state.roadTime > time : state.roadTime < time);

export class Simulation {
  readonly replays = new Map<bigint, ReplayRider>();

  readonly pelotons = new Map<string, Peloton>();

  readonly blobs = new Map<bigint, Blob>();

  readonly directors = new Map<bigint, GestureDirector>();

  readonly jokeTellers = new Map<bigint, JokeTeller>();

  readonly commentators = new Map<bigint, Commentator>();

  readonly jokes: Jokes;

  readonly commentary: Templates;

  readonly segments: ReadonlyMap<string, Segment>;

  private readonly packetsFed = new Map<bigint, number>();

  private readonly ftps = new Map<bigint, { at: number; ftp: number }>();

  readonly ghosts = new Map<bigint, RiderGhosts>();

  readonly bookmarks = new Map<bigint, Map<bigint, { state: PlayerState; name: string }>>();

  readonly lastGesture = new Map<bigint, { action: number; time: number }>();

  readonly pool: RiderPool;

  readonly ghostAppearance: z.infer<typeof ghostAppearanceSchema>;

  readonly starts: Record<string, { road: number; time: number; name?: string | undefined }>;

  readonly rng = new Random();

  timer: NodeJS.Timeout | null = null;

  lastPacer = 0;

  lastBot = 0;

  /** Resolves after the first replay load. Later reloads replace replays atomically. */
  readonly ready: Promise<void>;

  private readonly files = new AssetFiles();

  private readonly pending = new Set<Promise<void>>();

  private reloads = 0;

  private closed = false;

  private recording = { queue: Promise.resolve(), size: 0 };

  private autoGroup: {
    id: bigint;
    all: boolean;
    road: number;
    forward: boolean;
  } | null = null;

  constructor(
    readonly runtime: Runtime,
    readonly now: () => number = () => performance.now() / 1000,
  ) {
    this.ghostAppearance = ghostAppearanceSchema.parse(
      runtime.config.ghosts.profileFile ? JSON.parse(readFileSync(runtime.config.ghosts.profileFile, 'utf8')) : {},
    );
    this.pool = new RiderPool(runtime.assets, runtime.config.bots.ridersFile);
    this.starts = z
      .record(z.string(), z.object({ road: z.number(), time: z.number(), name: z.string().optional() }))
      .parse(JSON.parse(readFileSync(resolve(runtime.assets, 'data/start_lines.txt'), 'utf8')));
    // Static road assets and jokes load at startup; blobs are rebuilt on the riding path.
    Blob.roads(runtime.assets);
    this.jokes = loadJokes(runtime.assets);
    this.commentary = loadTemplates(runtime.assets);
    this.segments = loadSegments(runtime.assets);
    runtime.world.simulation = this;
    this.ready = this.reload();
  }

  /** Run a background load. Failures are logged; they never stop the simulation. */
  private track(work: Promise<void>) {
    const tracked = work.catch(() => {
      this.runtime.world.lifecycle.log.warn('simulation.load_failed', 'Simulation storage load failed');
    });

    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** Resolves when all background loads and writes have finished. */
  async idle() {
    await this.ready;

    while (this.pending.size > 0) await Promise.all(this.pending);
    await this.recording.queue;
  }

  start() {
    if (this.timer) return;
    this.closed = false;
    let expected = performance.now() + 500;
    this.timer = setInterval(() => {
      const now = performance.now();
      metrics.record(Metric.SimulationTickDelay, Math.max(0, now - expected));
      expected = now + 500;
      this.tick();
    }, 500);
  }

  /** Stop ticking, then wait for background loads and writes to finish. */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;

    return this.idle();
  }

  async reload() {
    const generation = ++this.reloads;
    const storage = this.runtime.config.storageDir;
    const replays = new Map<bigint, ReplayRider>();

    for (const file of await this.files.filesUnder(resolve(storage, 'robopacers'), 'route.bin')) {
      const [profileBytes, routeBytes] = await Promise.all([
        this.files.readAsync(resolve(file, '../profile.bin')),
        this.files.readAsync(file),
      ]);

      if (!profileBytes || !routeBytes) continue;

      try {
        const profile = fromBinary(PlayerProfileSchema, profileBytes);
        const states = fromBinary(GhostSchema, routeBytes).states;

        if (profile.id > 0n && states.length > 0)
          replays.set(profile.id, {
            profile,
            states,
            position: 0,
            pacer: true,
            folder: basename(resolve(file, '..')),
          });
      } catch {
        this.runtime.world.lifecycle.log.warn('simulation.invalid_pacer', 'Skipping invalid RoboPacer');
      }
    }

    if (this.runtime.config.bots.enabled) {
      let index = 1;

      const folders = await this.files.entriesAsync(storage);

      for (const folder of folders) {
        if (!folder.isDirectory() || !/^\d+$/.test(folder.name)) continue;

        for (const file of await this.files.filesUnder(resolve(storage, folder.name, 'ghosts'), '.bin')) {
          const bytes = await this.files.readAsync(file);

          if (!bytes) continue;

          try {
            const states = fromBinary(GhostSchema, bytes).states;

            if (states.length === 0) continue;

            for (let copy = 0; copy < this.runtime.config.bots.multiplier; copy++) {
              const id = BigInt(1_000_000 + index + copy * 10_000);
              const profile = this.pool.profile(id);
              replays.set(id, {
                profile,
                states,
                position: Math.floor(this.rng.value() * states.length),
                pacer: false,
                folder: '',
              });
            }

            index++;
          } catch {
            this.runtime.world.lifecycle.log.warn('simulation.invalid_bot', 'Skipping invalid bot recording');
          }
        }
      }
    }

    // A newer reload started during the reads; its result replaces this one.
    if (generation !== this.reloads || this.closed) return;

    for (const id of this.replays.keys()) {
      this.runtime.world.synthetic.delete(id);
      this.runtime.profiles.synthetic.delete(id);
    }

    this.replays.clear();

    for (const [id, replay] of replays) {
      this.replays.set(id, replay);
      this.runtime.profiles.synthetic.set(id, replay.profile);
    }

    this.loadPelotons();

    const ids = new Set([
      this.runtime.config.soloBlob.playerId,
      ...this.runtime.settings.worldIds().flatMap((id) => (id.startsWith('blob:') ? Number(id.slice(5)) : [])),
    ]);

    for (const id of ids) this.loadBlob(BigInt(id));
    this.tick();
  }

  loadPelotons() {
    for (const group of this.pelotons.values())
      for (const rider of group.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }

    this.pelotons.clear();

    const entries = new Map(this.runtime.config.pelotons.map((group) => [group.id, group]));

    for (const id of this.runtime.settings.worldIds())
      if (id.startsWith('peloton:')) {
        const key = id.slice(8);
        const defaults = entries.get(key);
        const saved = this.runtime.settings.world(id);

        const entry = configSchema.parse({
          pelotons: [{ ...defaults, ...saved, id: key }],
        }).pelotons[0];

        if (entry) entries.set(key, entry);
      }

    const pacers = this.replays
      .values()
      .filter((replay) => replay.pacer)
      .toArray()
      .sort((a, b) => Number(a.profile.id - b.profile.id));

    for (const [id, config] of entries) {
      if (!config.enabled) continue;

      const index = pacers.findIndex(
        (pacer) =>
          String(pacer.profile.id) === String(config.pacer) ||
          pacer.folder.toLowerCase() === String(config.pacer).toLowerCase(),
      );

      const pacer = pacers[index];

      if (!pacer || index >= 500 || this.pelotons.values().some((group) => group.pacer === pacer)) continue;
      const group = new Peloton(index, pacer, config, this.pool);
      this.pelotons.set(id, group);

      for (const rider of group.riders) this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
    }
  }

  loadBlob(id: bigint) {
    const previous = this.blobs.get(id);

    const index =
      previous?.index ?? [0, 1, 2, 3].find((index) => this.blobs.values().every((blob) => blob.index !== index));

    if (previous)
      for (const rider of previous.riders) {
        this.runtime.world.synthetic.delete(rider.profile.id);
        this.runtime.profiles.synthetic.delete(rider.profile.id);
      }

    this.blobs.delete(id);
    this.directors.delete(id);
    this.stopTalking(id);
    const saved = this.runtime.settings.world(`blob:${id}`);

    const config = configSchema.parse({
      soloBlob: {
        ...this.runtime.config.soloBlob,
        enabled: Number(id) === this.runtime.config.soloBlob.playerId && this.runtime.config.soloBlob.enabled,
        ...saved,
        playerId: Number(id),
      },
    }).soloBlob;

    if (!config.enabled || !config.riders) return;

    if (index === undefined) throw new Error('At most four simultaneous solo blobs are supported');

    const blob = new Blob(id, index, config, this.pool, this.runtime.assets, this.now);

    this.blobs.set(id, blob);
    this.directors.set(id, new GestureDirector(blob.rng, this.now(), config.gestureInterval));

    if (config.jokes) this.startTalking(id, blob);

    for (const rider of blob.riders) this.runtime.profiles.synthetic.set(rider.profile.id, rider.profile);
    const state = this.runtime.world.online.get(id);

    if (state) blob.receive(state, 0);
  }

  /** `.blob jokes`: the joke rider on or off, remembered in the world settings. The riders of the blob stay. */
  private toggleJokes(id: bigint, blob: Blob | undefined) {
    if (!blob) return 'Start a blob first.';
    const on = !this.jokeTellers.has(id);
    const saved = this.runtime.settings.world(`blob:${id}`);
    saved.jokes = on;
    this.runtime.settings.saveWorld(`blob:${id}`, saved);

    if (on) this.startTalking(id, blob);
    else this.stopTalking(id);

    return on ? 'Jokes on.' : 'Jokes off.';
  }

  /** The joke rider and, unless switched off, the remarks about the ride. */
  private startTalking(id: bigint, blob: Blob) {
    this.jokeTellers.set(id, new JokeTeller(blob.rng, this.jokes, blob.config.jokeInterval, this.now()));

    if (blob.config.jokeCommentary)
      this.commentators.set(id, new Commentator(blob.rng, this.commentary, blob.config.commentaryGap));
  }

  private stopTalking(id: bigint) {
    this.jokeTellers.delete(id);
    this.commentators.delete(id);
    this.packetsFed.delete(id);
  }

  /** The language of the messages: the setting, else the flag of the rider; English when there is nothing else. */
  private language(id: bigint, blob: Blob, available: ReadonlyMap<string, unknown>) {
    return resolveLanguage(blob.config.jokeLanguage, this.runtime.profiles.get(Number(id)).countryCode, available);
  }

  /** Your FTP: the `ftp` setting when set, else from your Zwift profile, looked up at most once a minute. */
  private ftpOf(id: bigint, blob: Blob, now: number) {
    if (blob.config.ftp > 0) return blob.config.ftp;
    const cached = this.ftps.get(id);

    if (cached && now - cached.at < 60) return cached.ftp;
    const ftp = Math.max(this.runtime.profiles.get(Number(id)).ftp, 0);
    this.ftps.set(id, { at: now, ftp });

    return ftp;
  }

  /** A finished sprint, KOM or segment, told by the bot furthest ahead soon after, with your earlier times. */
  segmentFinished(id: bigint, segmentId: bigint, elapsedMs: number, avgPower: number, previousMs: readonly number[]) {
    const commentator = this.commentators.get(id);
    const segment = this.segments.get(String(segmentId));

    if (!commentator || !segment) return;
    commentator.queueSegment(this.now(), { name: segment.name, kind: segment.kind, elapsedMs, avgPower, previousMs });
  }

  /** A bot that gives a hand signal may also say a line in the chat, under its own name. */
  quipGesture(id: bigint, blob: Blob, riderId: bigint, action: UserBikeAction, now: number, time: bigint) {
    const name = GESTURE_NAMES.get(action);
    const commentator = this.commentators.get(id);
    const teller = this.jokeTellers.get(id);
    const last = blob.trail.entries.at(-1);
    const rider = blob.riders.find((candidate) => candidate.profile.id === riderId);

    if (!name || !commentator || !teller || !rider || !last || now - last.time > JOKE_MAX_STATE_AGE_S) return;

    const text = commentator.gestureQuip(
      now,
      name,
      () => this.language(id, blob, this.commentary),
      blob.config.gestureTalk,
    );

    if (text === null) return;
    teller.reset(now);
    commentator.noteMessage(now);
    this.runtime.world.enqueue(chatUpdate(text, rider.profile.firstName, rider.profile.lastName, time), [id]);
  }

  /** The bot furthest ahead tells the rider a joke in the chat, under its own name, while the rider is riding. */
  private tellJoke(id: bigint, blob: Blob, now: number, time: bigint) {
    const teller = this.jokeTellers.get(id);

    if (!teller) return;
    const commentator = this.commentators.get(id);
    // The time a packet arrived, on this server's clock: the clock inside a packet is the game's own.
    const last = blob.trail.entries.at(-1);

    if (!last || now - last.time > JOKE_MAX_STATE_AGE_S) {
      // Nobody is riding: no joke should be waiting when riding starts again.
      teller.reset(now);
      commentator?.idle();

      return;
    }

    if (commentator && this.packetsFed.get(id) !== last.time) {
      this.packetsFed.set(id, last.time);

      commentator.update(last.time, {
        timeS: last.state.time,
        distanceM: last.state.distance,
        power: last.state.power,
        heartrate: last.state.heartrate,
        gradePct: blob.grade * 100,
        climbedM: last.state.climbing,
        ftp: this.ftpOf(id, blob, now),
      });
    }

    let leader: (typeof blob.riders)[number] | undefined;

    for (const rider of blob.riders) if (rider.gap < 0 && (!leader || rider.gap < leader.gap)) leader = rider;

    if (!leader) return;

    // A remark about your ride goes first; a joke only when there is none to make and one is due.
    let text =
      commentator?.poll(
        now,
        () => this.language(id, blob, this.commentary),
        () => this.starts[String(last.state.route)]?.name ?? 'Zwift',
      ) ?? null;

    if (text === null && teller.due(now)) text = teller.poll(now, this.language(id, blob, this.jokes));

    if (text === null) return;
    // Whatever was said, the next joke and the next remark are a full wait away.
    teller.reset(now);
    commentator?.noteMessage(now);
    this.runtime.world.enqueue(chatUpdate(text, leader.profile.firstName, leader.profile.lastName, time), [id]);
  }

  receive(id: bigint, state: PlayerState) {
    const blob = this.blobs.get(id);
    blob?.receive(state, clamp(Number(worldTime() - state.worldTime) / 1000, -5, 5));

    if (blob && blob.trail.resets !== blob.resets) {
      this.loadBlob(id);
    }

    const settings = SettingsService.resolveRiderSettings(
      this.runtime.config.riderDefaults,
      this.runtime.settings.read(Number(id)),
    );

    if (!settings.ghosts.enabled || !state.roadTime) return;

    const ghosts: RiderGhosts = this.ghosts.get(id) ?? {
      lastRoadTime: 0,
      loading: 'waiting',
      playback: 'waiting',
      startRoad: road(state),
      startTime: state.roadTime,
      last: 0,
      playbacks: [],
    };

    this.ghosts.set(id, ghosts);

    if (ghosts.lastRoadTime && state.roadTime !== ghosts.lastRoadTime) {
      if (ghosts.loading === 'waiting') {
        ghosts.loading = 'loading';

        const folder = resolve(this.runtime.profiles.folder(Number(id)), 'ghosts', String(course(state)));

        const directories = new Set([
          resolve(folder, String(road(state)), ...(forward(state) ? [] : ['reverse'])),
          ...(state.route ? [resolve(folder, String(state.route))] : []),
        ]);

        const start = this.starts[String(state.route)];

        if (start) {
          ghosts.startRoad = start.road;
          ghosts.startTime = start.time;
        }

        this.track(this.loadGhosts(id, ghosts, directories, this.runtime.world.generation(id)));
      }

      if (
        ghosts.playback === 'waiting' &&
        ghosts.playbacks.length > 0 &&
        road(state) === ghosts.startRoad &&
        ahead(state, ghosts.startTime)
      )
        this.regroup(id);
    }

    ghosts.lastRoadTime = state.roadTime;
  }

  /** Read recordings without blocking packets. A result attaches only to the
  session and ghost state that requested it; a new login retries the load.
  */
  private async loadGhosts(id: bigint, ghosts: RiderGhosts, directories: Set<string>, generation: number) {
    const recordings: PlayerState[][] = [];

    for (const directory of directories) {
      for (const { name } of await this.files.entriesAsync(directory)) {
        if (!name.endsWith('.bin') || recordings.length >= 100) continue;
        const bytes = await this.files.readAsync(resolve(directory, name));

        if (!bytes) continue;

        try {
          const states = fromBinary(GhostSchema, bytes).states;

          if (states.length > 0) recordings.push(states);
        } catch {
          this.runtime.world.lifecycle.log.warn('simulation.invalid_ghost', 'Skipping an invalid ghost recording');
        }
      }
    }

    const rider = recordings.length > 0 ? await this.runtime.profiles.load(Number(id)) : null;

    if (this.ghosts.get(id) !== ghosts || this.closed) return;

    if (this.runtime.world.generation(id) !== generation) {
      ghosts.loading = 'waiting';

      return;
    }

    for (const states of recordings) {
      const ghostId = id + BigInt(ghosts.playbacks.length + 1) * 10_000_000n;

      ghosts.playbacks.push({ id: ghostId, states, position: 0, date: states[0]?.worldTime ?? 0n });

      if (!rider) continue;
      const profile = clone(PlayerProfileSchema, rider);
      profile.id = ghostId;
      profile.firstName = '';
      profile.lastName = 'Ghost';
      profile.countryCode = 0;
      this.pool.customizeGhost(profile, this.ghostAppearance);
      this.runtime.profiles.synthetic.set(ghostId, profile);
    }

    ghosts.loading = 'loaded';
  }

  regroup(id: bigint) {
    const state = this.runtime.world.online.get(id);
    const ghosts = this.ghosts.get(id);

    if (!state || !ghosts) return;
    ghosts.playback = 'playing';

    for (const ghost of ghosts.playbacks) {
      const index = this.nearest(state, ghost.states);

      if (index !== null) ghost.position = index + (ahead(state, ghost.states[index]?.roadTime ?? 0) ? 1 : 0);
    }

    ghosts.last = 0;
  }

  nearest(state: PlayerState, states: PlayerState[]) {
    let index: number | null = null;
    let distance = Infinity;

    for (const [i, peer] of states.entries())
      if (course(state) === course(peer) && road(state) === road(peer) && forward(state) === forward(peer)) {
        const delta = Math.abs(state.roadTime - peer.roadTime);

        if (delta < distance) {
          index = i;
          distance = delta;
        }
      }

    return index;
  }

  group(id: bigint, all: boolean) {
    const state = this.runtime.world.online.get(id);

    if (!state) return;
    const seen = new Set<PlayerState[]>();

    for (const replay of this.replays.values())
      if (!replay.pacer && (all || !seen.has(replay.states))) {
        seen.add(replay.states);
        const index = this.nearest(state, replay.states);

        if (index !== null) replay.position = index;
      }
  }

  loadBookmarks(id: bigint) {
    return Promise.try(() => this.readBookmarks(id));
  }

  private readBookmarks(id: bigint) {
    const bookmarks = new Map<bigint, { state: PlayerState; name: string }>();

    for (const row of this.runtime.accounts.repositories.bookmarksRepository.list(Number(id))) {
      try {
        const state = fromBinary(PlayerStateSchema, row.state);
        state.id = 9_000_000n + (id % 1000n) * 1000n + BigInt(bookmarks.size + 1);
        bookmarks.set(state.id, { state, name: row.name });
      } catch {
        this.runtime.world.lifecycle.log.warn('simulation.invalid_bookmark', 'Skipping an invalid bookmark');
      }
    }

    this.bookmarks.set(id, bookmarks);

    return bookmarks;
  }

  bookmark(state: PlayerState, name: string) {
    const safe = name
      .normalize('NFKD')
      .replaceAll(/[^\w .-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120);

    if (!safe) return;
    const id = state.id;

    try {
      this.runtime.accounts.repositories.bookmarksRepository.save(
        Number(id),
        course(state),
        state.sport,
        safe,
        toBinary(PlayerStateSchema, state),
      );
    } catch {
      this.runtime.world.lifecycle.log.warn('simulation.bookmark_failed', 'Bookmark could not be saved');

      return;
    }

    this.readBookmarks(id);
  }

  logout(id: bigint) {
    const state = this.runtime.world.online.get(id);

    if (state) this.bookmark(state, state.sport === 1 ? 'Last run' : 'Last ride');
    this.ghosts.delete(id);
    this.runtime.world.personal.delete(id);

    for (const key of this.runtime.profiles.synthetic.keys())
      if (key > 10_000_000n && key % 10_000_000n === id) this.runtime.profiles.synthetic.delete(key);
    const blob = this.blobs.get(id);

    if (!blob) {
      return;
    }

    for (const rider of blob.riders) this.runtime.world.synthetic.delete(rider.profile.id);
    this.loadBlob(id);
  }

  gesture(id: bigint, payload: Uint8Array) {
    if (payload.length !== 16) return null;
    const buffer = Buffer.from(payload);

    if (buffer.readBigUInt64LE() !== id) return null;

    const action = z.nativeEnum(UserBikeAction).safeParse(buffer.readUInt32LE(8));

    if (!action.success) return null;
    const previous = this.lastGesture.get(id);

    if (previous?.action === action.data && this.now() - previous.time < 2) return null;
    this.lastGesture.set(id, { action: action.data, time: this.now() });

    return this.blobs.get(id)?.gesture(action.data) ?? null;
  }

  command(id: bigint, command: string, administrator = false) {
    const [name, ...parts] = command.trim().toLowerCase().split(/\s+/);
    const argument = parts.join(' ');

    if (name === 'regroup') {
      this.regroup(id);

      return 'Ghosts regrouped.';
    }

    if (name === 'bookmark') {
      const state = this.runtime.world.online.get(id);

      if (state) this.bookmark(state, argument);

      return 'Bookmark saved.';
    }

    // These change the world for every rider. Only the management area sends them, on behalf of a rider.
    if (!administrator && botCommand.safeParse(name).success)
      return 'Use the web app management area for server commands.';

    if (name === 'group' || name === 'groupall') {
      this.group(id, name === 'groupall');

      return 'Bots grouped.';
    }

    if (name === 'autogroup' || name === 'autogroupall') {
      this.trackGroup(id, name === 'autogroupall');

      return 'Automatic grouping enabled.';
    }

    if (name === 'stopautogroup' || name === 'disperse') {
      this.autoGroup = null;

      if (name === 'disperse')
        for (const replay of this.replays.values())
          if (!replay.pacer) replay.position = Math.floor(this.rng.value() * replay.states.length);

      return 'Automatic grouping stopped.';
    }

    if (name === 'blob') {
      const blob = this.blobs.get(id);

      if (!argument)
        return blob
          ? `Blob active: ${blob.riders.length} riders. Mode: ${blob.mode ?? 'normal'}.`
          : 'Blob off. Start with .blob <n>.';

      const actions = new Map([
        ['attack', UserBikeAction.UBA_ELBOW],
        ['hammer', UserBikeAction.UBA_HAMMER],
        ['toast', UserBikeAction.UBA_TOAST],
        ['lead', UserBikeAction.UBA_BELL],
      ]);

      const action = actions.get(argument);

      if (action !== undefined) return blob?.gesture(action) ?? 'Start a blob first.';

      if (['new', 'restart', 'reroll'].includes(argument)) {
        this.loadBlob(id);

        return 'New riders on the road.';
      }

      if (argument === 'jokes') return this.toggleJokes(id, blob);

      const saved = this.runtime.settings.world(`blob:${id}`);

      if (argument === 'record') saved.record = !(blob?.config.record ?? false);
      else if (argument === 'off' || argument === '0') saved.enabled = false;
      else if (/^\d+$/.test(argument) && Number(argument) <= 30 && Number(argument) > 0) {
        saved.enabled = true;
        saved.riders = Number(argument);
      } else return 'Usage: .blob <1..30>, new, off, record, jokes, hammer, toast, attack, lead';
      this.runtime.settings.saveWorld(`blob:${id}`, saved);
      this.loadBlob(id);

      return this.blobs.has(id) ? 'Blob settings saved.' : 'Blob off.';
    }

    if (name === 'peloton') {
      const state = this.runtime.world.online.get(id);

      if (!state) return 'Start riding first.';

      const score = (replay: ReplayRider) =>
        replay.profile.id === state.watchingRiderId
          ? -1
          : Math.hypot(
              (replay.states[replay.position]?.x ?? 0) - state.x,
              (replay.states[replay.position]?.z ?? 0) - state.z,
            );

      const pacer = this.replays
        .values()
        .filter((replay) => replay.pacer && course(replay.states[replay.position] ?? state) === course(state))
        .toArray()
        .sort((a, b) => {
          return score(a) - score(b);
        })[0];

      if (!pacer) return 'No RoboPacer on this course.';

      const existing = [...this.pelotons].find(([, group]) => group.pacer === pacer);

      const key = existing?.[0] ?? `pacer-${pacer.profile.id}`;

      if (!argument) return `${pacer.profile.lastName}: ${existing?.[1].riders.length ?? 0} bots.`;

      if (argument !== 'off' && (!/^\d+$/.test(argument) || Number(argument) > 200))
        return 'Usage: .peloton <0..200> | off';
      const saved = this.runtime.settings.world(`peloton:${key}`);
      Object.assign(saved, {
        pacer: Number(pacer.profile.id),
        enabled: argument !== 'off',
        bots: argument === 'off' ? 0 : Number(argument),
      });
      this.runtime.settings.saveWorld(`peloton:${key}`, saved);
      this.loadPelotons();

      return 'Peloton settings saved.';
    }

    return `Invalid command: ${command}`;
  }

  /** Off -> tracking; switching rider resets the road/direction checkpoint. */
  private trackGroup(id: bigint, all: boolean) {
    this.autoGroup = { id, all, road: -1, forward: false };
  }

  /** Append a blob recording line off the main thread. A slow disk drops lines
  instead of growing the queue without limit.
  */
  private record(line: string) {
    if (this.recording.size >= 1000) return;
    const file = resolve(this.runtime.config.storageDir, 'solo_blob_record.jsonl');
    this.recording.size++;

    this.recording.queue = this.recording.queue
      .then(async () => {
        const size = await stat(file)
          .then((info) => info.size)
          .catch(() => 0);

        if (size > 80 * 1024 * 1024) await rename(file, `${file}.old`);
        await appendFile(file, line);
      })
      .catch(() => {
        this.runtime.world.lifecycle.log.warn('simulation.record_failed', 'Blob recording could not be written');
      })
      .finally(() => {
        this.recording.size--;
      });
  }

  tick() {
    const now = this.now();
    const time = worldTime();
    const world = this.runtime.world;
    const pacers = now - this.lastPacer >= 1;
    const bots = now - this.lastBot >= 3;

    if (pacers) this.lastPacer = now;

    if (bots) this.lastBot = now;

    if (this.autoGroup) {
      const state = world.online.get(this.autoGroup.id);

      if (state && (road(state) !== this.autoGroup.road || forward(state) !== this.autoGroup.forward)) {
        this.group(this.autoGroup.id, this.autoGroup.all);
        this.autoGroup.road = road(state);
        this.autoGroup.forward = forward(state);
      }
    }

    for (const [id, replay] of this.replays)
      if ((replay.pacer && pacers) || (!replay.pacer && bots) || !world.synthetic.has(id)) {
        replay.position = (replay.position + 1) % replay.states.length;
        const original = replay.states[replay.position];

        if (!original) continue;
        const state = clone(PlayerStateSchema, original);
        state.id = id;
        state.worldTime = time - 300n;
        state.groupId = 0n;
        world.synthetic.set(id, state);
      }

    if (pacers)
      for (const group of this.pelotons.values())
        for (const state of group.tick(now, time)) world.synthetic.set(state.id, state);

    for (const [id, blob] of this.blobs) {
      const states = blob.tick(time);

      for (const rider of blob.riders) world.synthetic.delete(rider.profile.id);

      for (const state of states) world.synthetic.set(state.id, state);

      const gesture = blob.config.botGestures
        ? this.directors
            .get(id)
            ?.step(now, blob.riders, blob.config.gestureInterval, blob.trail.motion().speed, blob.config.gestureChance)
        : null;

      if (gesture) {
        world.enqueue(gestureUpdate(gesture.action, gesture.state, time), [id]);
        this.quipGesture(id, blob, gesture.state.id, gesture.action, now, time);
      }

      this.tellJoke(id, blob, now, time);

      if (!(blob.config.record && states.length > 0)) continue;

      this.record(
        `${JSON.stringify({ time: Number(time), playerId: String(id), mode: blob.mode, grade: blob.grade, shift: blob.shift, riders: blob.riders.map((rider) => ({ id: String(rider.profile.id), gap: rider.gap, lateral: rider.lateral, rate: rider.rate, phase: rider.phase })) })}\n`,
      );
    }

    for (const [id, ghosts] of this.ghosts)
      if (ghosts.playback === 'playing' && now - ghosts.last >= 3) {
        ghosts.last = now;
        const personal = world.personal.get(id) ?? new Map();

        for (const ghost of ghosts.playbacks) {
          const original = ghost.states[ghost.position++];

          if (!original) {
            personal.delete(ghost.id);
            continue;
          }

          const state = clone(PlayerStateSchema, original);
          state.id = ghost.id;
          state.worldTime = time - 300n;
          state.groupId = 0n;
          personal.set(state.id, state);
        }

        world.personal.set(id, personal);
      }

    for (const [id, bookmarks] of this.bookmarks) {
      const personal = world.personal.get(id) ?? new Map();

      for (const [key, bookmark] of bookmarks) {
        const state = clone(PlayerStateSchema, bookmark.state);
        state.worldTime = time - 300n;
        personal.set(key, state);
      }

      world.personal.set(id, personal);
    }
  }
}
