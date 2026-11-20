import type { PlanBlock, WorkoutPlan } from '#src/world/zwo';
import type { WadEntry } from '#src/world/wad';

/**
The workout XML files inside workouts.wad use Zwift's own element names and
carry the ids the client log prints. The on-screen speech bubbles are the
textevent messages, timed from the start of their block — exactly what the
game shows the rider, so the voice can read it in step.
*/
export interface WadCue {
  /** Seconds from the workout start. */
  at: number;
  message: string;
}

export interface WadWorkout {
  /** legacyIdHash as printed by the client log. */
  id: string;
  uuid: string;
  plan: WorkoutPlan;
  cues: WadCue[];
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const unescape = (text: string) =>
  text.replaceAll(/&(amp|lt|gt|quot|apos|#\d+);/g, (all, entity: string) =>
    entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1))) : (ENTITIES.get(entity) ?? all),
  );

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

const number = (value: string | null) => (value === null ? null : Number(value));

/** Percent ratios like ".65" become the plan power this server already speaks. */
function power(low: string | null, high: string | null, single: string | null) {
  const values = [low, high, single].flatMap((value) => (value === null ? [] : Number(value)));

  if (values.length === 0) return null;

  return {
    format: 'ftp' as const,
    low: Math.round(Math.min(...values) * 100),
    high: Math.round(Math.max(...values) * 100),
  };
}

const BLOCK =
  /<(Warmup|Cooldown|SteadyState|Ramp|IntervalsT|Race|Marathon|ForTheWin|Endurance)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;

const TEXT = /<textevent[^>]*timeoffset="(\d+)"[^>]*message="([^"]*)"[^>]*\/>/gi;

/** Parse one Zwift native workout XML; null when it is not a workout. */
export function parseWadWorkout(xml: string): WadWorkout | null {
  const id = /<legacyIdHash>(\d+)<\/legacyIdHash>/.exec(xml)?.[1] ?? '';
  const uuid = /<uniqueId>([^<]+)<\/uniqueId>/.exec(xml)?.[1] ?? '';
  const name = /<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? '';

  if (!name) return null;

  const blocks: PlanBlock[] = [];
  const cues: WadCue[] = [];
  let elapsed = 0;

  for (const match of xml.matchAll(BLOCK)) {
    const element = match[1]!;
    const tag = match[2]!;
    const content = match[3] ?? '';
    const label = element === 'IntervalsT' ? 'Intervals' : element;

    const texts = content
      .matchAll(TEXT)
      .map((text) => ({ at: elapsed + Number(text[1]), message: unescape(text[2]!) }))
      .toArray();

    cues.push(...texts);

    const repeat = Math.min(1000, number(attr(tag, 'Repeat')) ?? 1);
    const on = number(attr(tag, 'OnDuration'));
    const off = number(attr(tag, 'OffDuration'));
    const duration = number(attr(tag, 'Duration'));

    if (on === null || off === null) {
      blocks.push({
        name: label,
        durationSeconds: duration ?? 0,
        meters: null,
        power: power(attr(tag, 'PowerLow'), attr(tag, 'PowerHigh'), attr(tag, 'Power')),
        cadence: null,
      });
      elapsed += duration ?? 0;
    } else {
      // The game counts every on and every off of a set of intervals as a split of its own.
      for (let round = 0; round < repeat; round++) {
        blocks.push(
          {
            name: `${label} on`,
            durationSeconds: on,
            meters: null,
            power: power(attr(tag, 'OnPower'), attr(tag, 'OnPower'), null),
            cadence: null,
          },
          {
            name: `${label} off`,
            durationSeconds: off,
            meters: null,
            power: power(attr(tag, 'OffPower'), attr(tag, 'OffPower'), null),
            cadence: null,
          },
        );
      }

      elapsed += on * repeat + off * repeat;
    }
  }

  if (blocks.length === 0) return null;

  cues.sort((a, b) => a.at - b.at);

  return { id, uuid, cues, plan: { name: unescape(name), blocks, totalSeconds: elapsed } };
}

/** Index every workout of a decoded wad by both ids the client log may print. */
export function indexWadWorkouts(entries: readonly WadEntry[]): Map<string, WadWorkout> {
  const index = new Map<string, WadWorkout>();

  for (const entry of entries) {
    if (!entry.name.endsWith('.xml')) continue;

    const workout = parseWadWorkout(new TextDecoder().decode(entry.data));

    if (!workout) continue;

    if (workout.id) index.set(workout.id, workout);

    if (workout.uuid) index.set(workout.uuid, workout);
  }

  return index;
}
