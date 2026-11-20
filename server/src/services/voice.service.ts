import { RuntimeContext } from '#src/context';
import {
  blockSpeech,
  chatLanguage,
  chatSpeech,
  countdownSpeech,
  finishSpeech,
  startSpeech,
  summarySpeech,
  targetSpeech,
} from '#src/world/voice-speech';
import type { VoiceLanguage } from '#src/world/voice-speech';
import type { WadWorkout } from '#src/world/wadplan';
import type { WorkoutPlan } from '#src/world/zwo';
import { parseLine } from '#src/world/zwiftlog';
import { powerRatio, rampProgress, stepStarts } from '#src/world/narration';
import { Context, Effect, Layer } from 'effect';

/** One line for the rider's voice client, in their language. */
export interface VoiceEvent {
  kind: 'chat' | 'summary' | 'block' | 'countdown' | 'finish' | 'start' | 'target' | 'cue';
  speak: string;
  /** Force another language than the client's TTS picks by default. */
  lang?: VoiceLanguage | undefined;
  /** The rider wrote this chat bubble themselves. */
  self?: boolean;
}

/** An in-game chat bubble, as the world hands it over. */
export interface SocialUpdate {
  playerId: bigint;
  from: string;
  text: string;
}

interface Listener {
  language: VoiceLanguage;
  send: (event: VoiceEvent) => void;
}

/** How long a fetched plan stays the plan of the next workout the game starts. */
const SERVER_PLAN_FRESH_MS = 15 * 60 * 1000;

interface NarrationState {
  plan: WorkoutPlan;
  cues: ReadonlyArray<{ at: number; message: string }>;
  ftp: number;
  step: number;
  stepStartedAt: number;
  lastEventAt: number;
  spoken: Set<number>;
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const log = context.world.lifecycle.log;

  const listeners = new Map<number, Set<Listener>>();
  const timers = new Map<number, ReturnType<typeof setTimeout>[]>();
  const planned = new Set<number>();

  let riding = false;
  let wadWorkouts = new Map<string, WadWorkout>();
  let serverPlan: { plan: WorkoutPlan; fetchedAt: number } | undefined;
  let narration: NarrationState | undefined;

  let lastNarration:
    | { plan: WorkoutPlan; cues: ReadonlyArray<{ at: number; message: string }>; ftp: number }
    | undefined;

  let lastErg: { watts: number; at: number } | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let ergAnnounced = false;
  let ergQuiet: ReturnType<typeof setTimeout> | undefined;

  const narrationKey = -1;
  const ftpFromEnv = Math.max(0, Number(process.env.ZWIFT_FTP ?? '0') || 0);

  const clearAll = () => {
    clearInterval(watchTimer);
    watchTimer = undefined;
    clearTimeout(ergQuiet);
    ergQuiet = undefined;

    for (const list of timers.values()) {
      for (const timer of list) clearTimeout(timer);
    }

    timers.clear();
  };

  yield* Effect.addFinalizer(() => Effect.sync(clearAll));

  const broadcast = (kind: VoiceEvent['kind'], build: (language: VoiceLanguage) => string, lang?: VoiceLanguage) => {
    for (const set of listeners.values()) {
      for (const listener of set) {
        listener.send({ kind, speak: build(listener.language), lang });
      }
    }
  };

  const clearNarrationTimers = () => {
    for (const timer of timers.get(narrationKey) ?? []) clearTimeout(timer);

    timers.delete(narrationKey);
  };

  const cancelAllPlayerTimers = () => {
    for (const [key, list] of timers) {
      if (key === narrationKey) continue;

      for (const timer of list) clearTimeout(timer);
    }

    for (const key of timers.keys()) {
      if (key !== narrationKey) timers.delete(key);
    }
  };

  const endNarration = (reason: string, final: boolean) => {
    const current = narration;

    clearInterval(watchTimer);
    watchTimer = undefined;
    clearNarrationTimers();
    clearTimeout(ergQuiet);
    ergQuiet = undefined;
    narration = undefined;

    if (final) lastNarration = undefined;

    if (current !== undefined) log.info('voice.zwift', reason);
  };

  const learnFtpAtStart = (state: { plan: WorkoutPlan; ftp: number }) => {
    const first = state.plan.blocks.at(0);
    const ratio = first === undefined ? null : powerRatio(first, 0);
    const target = lastErg;

    if (state.ftp > 0 || ratio === null || ratio <= 0 || target === undefined) return;

    if (Date.now() - target.at <= 15_000) state.ftp = target.watts / ratio;
  };

  /** Starts reading a plan whose segments the game announces by its split counter. */
  const startNarration = (plan: WorkoutPlan, cues: NarrationState['cues'], announce: boolean) => {
    const now = Date.now();

    const state: NarrationState = {
      plan,
      cues,
      ftp: ftpFromEnv,
      step: -1,
      stepStartedAt: now,
      lastEventAt: now,
      spoken: new Set<number>(),
    };

    narration = state;
    log.info('voice.wad', 'Reading the workout aloud as the game starts its segments', {
      name: plan.name,
      blocks: plan.blocks.length,
      cues: cues.length,
      seconds: plan.totalSeconds,
    });
    learnFtpAtStart(state);

    if (announce) broadcast('summary', (language) => summarySpeech(plan, language));

    watch();
  };

  const watch = () => {
    clearInterval(watchTimer);

    watchTimer = setInterval(() => {
      const current = narration;

      if (current === undefined) {
        clearInterval(watchTimer);
        watchTimer = undefined;

        return;
      }

      const block = current.plan.blocks[current.step];
      const allowedMs = ((block?.durationSeconds ?? 0) + (current.step < 0 ? 60 : 90)) * 1000;

      if (Date.now() - current.lastEventAt <= allowedMs) return;

      lastNarration = { plan: current.plan, cues: current.cues, ftp: current.ftp };
      endNarration('No word from the game for a while: the narration waits for the next segment', false);
    }, 5000);

    watchTimer.unref();
  };

  const resumeNarration = () => {
    const last = lastNarration;

    if (last === undefined || !riding) return null;

    const now = Date.now();

    const state: NarrationState = {
      plan: last.plan,
      cues: last.cues,
      ftp: last.ftp,
      step: -1,
      stepStartedAt: now,
      lastEventAt: now,
      spoken: new Set<number>(),
    };

    lastNarration = undefined;
    narration = state;
    log.info('voice.zwift', 'The workout goes on: the narration follows it again');
    watch();

    return state;
  };

  const armStep = (state: NarrationState, elapsedS: number) => {
    const blocks = state.plan.blocks;
    const step = state.step;
    const block = blocks[step];

    if (block === undefined) return;

    const start = stepStarts(blocks)[step] ?? 0;
    const duration = block.durationSeconds ?? 0;
    const last = step === blocks.length - 1;
    const scheduled: ReturnType<typeof setTimeout>[] = [];

    const at = (delayS: number, fire: () => void) => {
      if (delayS >= 0) scheduled.push(setTimeout(fire, delayS * 1000));
    };

    for (const [index, cue] of state.cues.entries()) {
      if (cue.at < start || (!last && cue.at >= start + duration) || state.spoken.has(index)) continue;

      at(cue.at - start - elapsedS, () => {
        state.spoken.add(index);
        broadcast('cue', () => cue.message, 'en');
      });
    }

    if (duration >= 25) {
      at(duration - 15 - elapsedS, () =>
        broadcast('countdown', (language) => countdownSpeech(15, blocks[step + 1] ?? null, language)),
      );
    }

    if (last) {
      at(duration - elapsedS, () => {
        broadcast('finish', finishSpeech);
        endNarration('The plan is complete', true);
      });
    }

    timers.set(narrationKey, scheduled);
  };

  const ergNarration = (watts: number) => {
    const current = narration;

    if (current === undefined) return;

    const now = Date.now();
    const block = current.plan.blocks[current.step];

    current.lastEventAt = now;

    if (block === undefined) return;

    const elapsed = (now - current.stepStartedAt) / 1000;

    if (current.ftp <= 0) {
      const ratio = powerRatio(block, elapsed);

      if (ratio !== null && ratio > 0) current.ftp = watts / ratio;

      return;
    }

    const progress = rampProgress(block, current.ftp, watts);

    if (progress === null || Math.abs(progress - elapsed) <= 6) return;

    log.info('voice.wad', 'Re-timed the narration of the ramp to the screen', {
      shiftSeconds: Math.round(progress - elapsed),
      watts,
    });
    current.stepStartedAt = now - progress * 1000;
    clearNarrationTimers();
    armStep(current, progress);
  };

  const onSplit = (n: number) => {
    const current = narration ?? resumeNarration();

    if (!current) return;

    const blocks = current.plan.blocks;
    const step = n - 1;
    const block = blocks[step];

    clearNarrationTimers();
    current.lastEventAt = Date.now();

    if (block === undefined) {
      if (step >= blocks.length) endNarration('Every segment of the plan has been ridden', true);

      return;
    }

    current.step = step;
    current.stepStartedAt = Date.now();

    if (step > 0) broadcast('block', (language) => blockSpeech(block, step, blocks.length, language, 'now'));

    armStep(current, 0);
  };

  const schedule = (player: number, plan: WorkoutPlan) => {
    for (const timer of timers.get(player) ?? []) clearTimeout(timer);

    const scheduled: ReturnType<typeof setTimeout>[] = [];

    const at = (delayS: number, kind: VoiceEvent['kind'], build: (language: VoiceLanguage) => string) => {
      if (delayS < 0) return;

      scheduled.push(
        setTimeout(() => {
          for (const listener of listeners.get(player) ?? []) {
            listener.send({ kind, speak: build(listener.language) });
          }
        }, delayS * 1000),
      );
    };

    at(0, 'summary', (language) => summarySpeech(plan, language));

    let elapsed = 0;

    for (const [index, block] of plan.blocks.entries()) {
      const duration = block.durationSeconds ?? 0;

      if (index > 0) {
        at(elapsed - 3, 'block', (language) => blockSpeech(block, index, plan.blocks.length, language));
      }

      if (duration >= 25) {
        at(elapsed + duration - 15, 'countdown', (language) =>
          countdownSpeech(15, plan.blocks[index + 1] ?? null, language),
        );
      }

      elapsed += duration;
    }

    if (elapsed > 0) at(elapsed, 'finish', finishSpeech);

    timers.set(player, scheduled);
  };

  return {
    subscribe: Effect.fn('VoiceService.subscribe')(function* (
      player: number,
      language: VoiceLanguage,
      send: (event: VoiceEvent) => void,
    ) {
      const set = listeners.get(player) ?? new Set();
      const listener = { language, send };

      set.add(listener);
      listeners.set(player, set);
      log.info('voice.stream', 'Voice client listening', { player, language });

      return () => {
        set.delete(listener);

        if (set.size === 0) listeners.delete(player);
      };
    }),

    onSocial: Effect.fn('VoiceService.onSocial')(function* (update: SocialUpdate, recipients: readonly bigint[]) {
      if (!update.text) return;

      for (const [player, set] of listeners) {
        const to = BigInt(player);

        if (!recipients.includes(to)) continue;

        for (const listener of set) {
          const self = update.playerId === to;

          listener.send({
            kind: 'chat',
            self,
            speak: chatSpeech(self ? '' : update.from, update.text, listener.language),
            lang: chatLanguage(update.text),
          });
        }
      }
    }),

    setWadWorkouts: Effect.fn('VoiceService.setWadWorkouts')(function* (workouts: Map<string, WadWorkout>) {
      wadWorkouts = workouts;
      log.info('voice.wad', 'Indexed the workout library bundled in the game', { ids: workouts.size });
    }),

    onWorkout: Effect.fn('VoiceService.onWorkout')(function* (player: number, plan: WorkoutPlan) {
      planned.add(player);
      serverPlan = { plan, fetchedAt: Date.now() };
      log.info('voice.workout', 'Reading the workout aloud', {
        player,
        name: plan.name,
        blocks: plan.blocks.length,
        seconds: plan.totalSeconds,
      });

      // The game log was faster than the fetch: the segments are already coming, so no clock is needed.
      if (riding && narration === undefined) {
        cancelAllPlayerTimers();
        startNarration(plan, [], true);

        return;
      }

      schedule(player, plan);
    }),

    onZwiftLine: Effect.fn('VoiceService.onZwiftLine')(function* (line: string) {
      const fact = parseLine(line);

      if (!fact) return;

      if (fact.kind === 'workout-start') {
        riding = true;
        ergAnnounced = false;
        lastNarration = undefined;
        endNarration('A new workout replaces the narration of the previous one', true);
        log.info('voice.zwift', 'The game started a workout it never fetched here', { id: fact.id });

        // A plan fetched long ago was only looked at: the workout that starts now is another one.
        if (serverPlan !== undefined && Date.now() - serverPlan.fetchedAt > SERVER_PLAN_FRESH_MS) {
          serverPlan = undefined;
          planned.clear();
          cancelAllPlayerTimers();
        }

        if (serverPlan !== undefined) {
          // The rider fetched this plan from here, so it is the one on the screen; its summary was read at the fetch.
          cancelAllPlayerTimers();
          startNarration(serverPlan.plan, [], false);

          return;
        }

        const wad = wadWorkouts.get(fact.uuid) ?? wadWorkouts.get(String(fact.id));

        if (wad && planned.size === 0) {
          startNarration(wad.plan, wad.cues, true);

          return;
        }

        if (planned.size === 0) broadcast('start', startSpeech);

        return;
      }

      if (fact.kind === 'erg') {
        lastErg = { watts: fact.to, at: Date.now() };

        if (narration !== undefined) {
          ergNarration(fact.to);

          return;
        }

        if (!riding || planned.size > 0) return;

        const sayTarget = () => {
          ergAnnounced = true;
          log.info('voice.zwift', 'Reading the next ERG target', { watts: fact.to });
          broadcast('target', (language) => targetSpeech(fact.to, language));
        };

        if (ergAnnounced) {
          if (ergQuiet !== undefined) clearTimeout(ergQuiet);

          ergQuiet = setTimeout(sayTarget, 2000);
        } else {
          sayTarget();
        }

        return;
      }

      if (fact.kind === 'split') {
        onSplit(fact.n);

        return;
      }

      riding = false;
      planned.clear();
      serverPlan = undefined;
      endNarration('The game ended the workout it started', true);
      cancelAllPlayerTimers();
    }),

    stop: Effect.fn('VoiceService.stop')(function* (player: number) {
      for (const timer of timers.get(player) ?? []) clearTimeout(timer);

      timers.delete(player);
    }),
  };
});

/**
The ride read aloud: chat bubbles of the game and the blocks of a running
workout reach every voice client of the rider over its stream. A rider
fetching their .zwo file is the start of the workout, so the block
announcements are scheduled from that moment on the wall clock. What the
bundled game library shows never passes this server: its facts come from
the Zwift client's own log instead, followed like a second screen.
*/
export class VoiceService extends Context.Service<VoiceService, Effect.Success<typeof make>>()(
  'zluggish/VoiceService',
) {
  static readonly layer = Layer.effect(VoiceService, make);
}
