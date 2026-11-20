import { RuntimeContext } from '#src/context';
import {
  blockSpeech,
  chatLanguage,
  chatSpeech,
  countdownSpeech,
  finishSpeech,
  summarySpeech,
} from '#src/world/voice-speech';
import type { VoiceLanguage } from '#src/world/voice-speech';
import type { WorkoutPlan } from '#src/world/zwo';
import { Context, Effect, Layer } from 'effect';

/** One line for the rider's voice client, in their language. */
export interface VoiceEvent {
  kind: 'chat' | 'summary' | 'block' | 'countdown' | 'finish';
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

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const log = context.world.lifecycle.log;

  const listeners = new Map<number, Set<Listener>>();
  const timers = new Map<number, Array<ReturnType<typeof setTimeout>>>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const list of timers.values()) {
        for (const timer of list) {
          clearTimeout(timer);
        }
      }

      timers.clear();
    }),
  );

  const schedule = (player: number, plan: WorkoutPlan) => {
    for (const timer of timers.get(player) ?? []) {
      clearTimeout(timer);
    }

    const scheduled: Array<ReturnType<typeof setTimeout>> = [];

    const at = (delayS: number, kind: VoiceEvent['kind'], build: (language: VoiceLanguage) => string) => {
      if (delayS < 0) {
        return;
      }

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

    if (elapsed > 0) {
      at(elapsed, 'finish', finishSpeech);
    }

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

        if (set.size === 0) {
          listeners.delete(player);
        }
      };
    }),

    onSocial: Effect.fn('VoiceService.onSocial')(function* (update: SocialUpdate, recipients: ReadonlyArray<bigint>) {
      if (!update.text) {
        return;
      }

      for (const [player, set] of listeners) {
        const to = BigInt(player);

        if (!recipients.includes(to)) {
          continue;
        }

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

    onWorkout: Effect.fn('VoiceService.onWorkout')(function* (player: number, plan: WorkoutPlan) {
      log.info('voice.workout', 'Reading the workout aloud', {
        player,
        name: plan.name,
        blocks: plan.blocks.length,
        seconds: plan.totalSeconds,
      });
      schedule(player, plan);
    }),

    stop: Effect.fn('VoiceService.stop')(function* (player: number) {
      for (const timer of timers.get(player) ?? []) {
        clearTimeout(timer);
      }

      timers.delete(player);
    }),
  };
});

/**
The ride read aloud: chat bubbles of the game and the blocks of a running workout reach every voice client of the
rider over its stream. A rider fetching their .zwo file is the start of the workout, so the block announcements are
scheduled from that moment on the wall clock.
*/
export class VoiceService extends Context.Service<VoiceService, Effect.Success<typeof make>>()(
  'zluggish/VoiceService',
) {
  static readonly layer = Layer.effect(VoiceService, make);
}
