import type { Random } from '#src/world/geometry';
import { formatTime } from '#src/world/segments';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Coach remarks of the joke rider: how your ride is going and where you are. The rider at the front of the
group occasionally says something about the route, every 15 minutes and 10 km, a climb or a descent, how hard
you are riding against your FTP, a burst, or a sprint or KOM you just finished. Statistics come from the
packets of the rider. The texts live in data/commentary.txt: { language: { kind: [templates] } }.
*/
export const DEFAULT_LANGUAGE = 'en';

const DECIMAL_COMMA = new Set(['pl']);

/** At least this long between two remarks, by default. */
export const DEFAULT_GAP_S = 120;

/** A rider who gives a hand signal says a line with it this often by default. */
export const GESTURE_QUIP_CHANCE = 0.5;

const MIN_RIDE_S = 60;
const ROUTE_AFTER_S = 90;
const TIME_STEP_MIN = 15;
const DISTANCE_STEP_KM = 10;
const CLIMB_GRADE_PCT = 4;
const CLIMB_HOLD_S = 20;
const DESCENT_GRADE_PCT = -4;
const DESCENT_HOLD_S = 15;
const GRADE_HYSTERESIS_PCT = 1;
const GRADE_COOLDOWN_S = 600;
const TREND_MIN_RIDE_S = 300;
const TREND_WINDOW_S = 60;
const TREND_MIN_PEDALLING_S = 30;
const TREND_STRONGER = 1.15;
const TREND_WEAKER = 0.85;
const TREND_COOLDOWN_S = 900;
const NEW_RIDE_JUMP_S = 60;
const MAX_SAMPLE_DT_S = 5;
const SEGMENT_EVENT_TTL_S = 90;
const SEGMENT_SPACING_S = 20;
const SAME_TIME_MS = 50;
const EFFORT_EASY_BELOW = 0.6;
const EFFORT_STEADY_BELOW = 0.9;
const EFFORT_HARD_BELOW = 1.05;
const EFFORT_MIN_PEDALLING_S = 30;
const EFFORT_HOLD_S = { easy: 60, steady: 60, hard: 30, over: 30 };
const EFFORT_COOLDOWN_S = { easy: 300, steady: 600, hard: 300, over: 300 };
const EFFORT_ANY_COOLDOWN_S = 240;
const BURST_START_RATIO = 1.1;
const BURST_END_RATIO = 1;
const BURST_SHORT_WINDOW_S = 5;
const BURST_MIN_SAMPLES = 3;
const BURST_MIN_S = 20;
const BURST_MAX_S = 120;
const BURST_TTL_S = 30;
const BURST_COOLDOWN_S = 150;
const GESTURE_QUIP_SPACING_S = 30;
const ROUTE_RETRY_S = 30;

type Zone = keyof typeof EFFORT_HOLD_S;

/** One packet of the rider, as far as the remarks need it. */
export interface Sample {
  timeS: number;
  distanceM: number;
  power: number;
  heartrate: number;
  gradePct: number;
  climbedM: number;
  /** Your FTP in watts, 0 when unknown. */
  ftp: number;
}

/** You finished a sprint, KOM or segment; `previousMs` are your earlier times on it. */
export interface SegmentEvent {
  name: string;
  kind: string;
  elapsedMs: number;
  avgPower: number;
  previousMs: readonly number[];
}

interface Pool {
  texts: ReadonlyMap<string, readonly string[]>;
  /** What a sprint, a KOM or any other segment is called in the language. */
  segmentKinds: Readonly<Record<string, string>>;
  /** The heart rate part of a remark, `{hr_text}`; empty when the language has none. */
  heartrate: string;
}

export type Templates = ReadonlyMap<string, Pool>;

type Values = Record<string, string | number>;

const templateFile = z.record(
  z.string(),
  z
    .object({ hr_text: z.string().default(''), segment_kinds: z.record(z.string(), z.string()).default({}) })
    .catchall(z.array(z.string())),
);

/** Templates by language, from data/commentary.txt. Blank texts are dropped. */
export function loadTemplates(assets: string): Templates {
  const file = templateFile.parse(JSON.parse(readFileSync(resolve(assets, 'data/commentary.txt'), 'utf8')));
  const templates = new Map<string, Pool>();

  for (const [language, kinds] of Object.entries(file)) {
    const texts = new Map<string, readonly string[]>();

    for (const [kind, items] of Object.entries(kinds)) {
      if (kind === 'hr_text' || kind === 'segment_kinds') continue;

      const clean = z
        .array(z.string())
        .parse(items)
        .map((text) => text.trim())
        .filter(Boolean);

      if (clean.length > 0) texts.set(kind, clean);
    }

    templates.set(language.toLowerCase(), { texts, segmentKinds: kinds.segment_kinds, heartrate: kinds.hr_text });
  }

  return templates;
}

/** Fill `{name}` placeholders; a placeholder without a value is an error, so a broken template is noticed. */
export function fill(template: string, values: Values) {
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];

    if (value === undefined) throw new Error(`No value for {${key}}`);

    return String(value);
  });
}

/** 'easy' | 'steady' | 'hard' | 'over' for power as a share of FTP. */
export function effortZone(ratio: number): Zone {
  if (ratio < EFFORT_EASY_BELOW) return 'easy';

  if (ratio < EFFORT_STEADY_BELOW) return 'steady';

  return ratio < EFFORT_HARD_BELOW ? 'hard' : 'over';
}

/** 3400 -> '3.4', 10000 -> '10'. */
export function formatKm(meters: number) {
  const km = meters / 1000;

  return Math.abs(km - Math.round(km)) < 0.05 ? String(Math.round(km)) : km.toFixed(1);
}

const step = (value: number, size: number) => Math.floor(value / size) * size;

/** Collects the ride statistics and decides what, if anything, the rider says about it right now. */
export class Commentator {
  private lastRemark: number | null = null;

  private segments: { at: number; event: SegmentEvent }[] = [];

  private lastSegmentSaid: number | null = null;

  private pendingBurst: { at: number; seconds: number; percent: number } | null = null;

  private lastBurstEnd: number | null = null;

  private lastQuip: number | null = null;

  private readonly unused = new Map<string, string[]>();

  private readonly lastPick = new Map<string, string>();

  private powerSum = 0;

  private powerTime = 0;

  private window: { at: number; power: number; seconds: number }[] = [];

  private routeRetryAt = 0;

  private zone: Zone | null = null;

  private zoneSince: number | null = null;

  private short: { at: number; power: number }[] = [];

  private burstSince: number | null = null;

  private burstPeak = 0;

  private lastSample: Sample | null = null;

  private lastNow: number | null = null;

  private timeDoneMin = 0;

  private distanceDoneKm = 0;

  private climbSince: number | null = null;

  private descentSince: number | null = null;

  private said = new Map<string, number>();

  private routeSaid = false;

  constructor(
    private readonly rng: Random,
    readonly templates: Templates,
    private readonly gap = DEFAULT_GAP_S,
  ) {}

  get averagePower() {
    return this.powerTime > 0 ? Math.round(this.powerSum / this.powerTime) : 0;
  }

  /** The rider said something else (a joke): keep the minimum gap before the next remark. */
  noteMessage(now: number) {
    this.lastRemark = now;
  }

  /** You stopped riding: a climb or descent in progress starts counting again afterwards. */
  idle() {
    this.climbSince = null;
    this.descentSince = null;
    this.zone = null;
    this.zoneSince = null;
    this.burstSince = null;
    this.lastNow = null;
  }

  /** Feed one new packet of the rider (`now` = seconds on the server's clock). */
  update(now: number, sample: Sample) {
    let last = this.lastSample;

    if (last && sample.timeS < last.timeS - NEW_RIDE_JUMP_S) {
      this.resetRide();
      last = null;
    }

    if (!last) this.seed(sample);
    const dt = this.lastNow === null ? 0 : Math.min(now - this.lastNow, MAX_SAMPLE_DT_S);

    if (sample.power > 0 && dt > 0) {
      this.powerSum += sample.power * dt;
      this.powerTime += dt;
      this.window.push({ at: now, power: sample.power, seconds: dt });
    }

    this.window = this.window.filter((entry) => now - entry.at <= TREND_WINDOW_S);
    this.updateEffortZone(now, sample);
    this.updateBurst(now, sample);
    this.climbSince = this.hold(
      this.climbSince,
      now,
      sample.gradePct >= CLIMB_GRADE_PCT,
      sample.gradePct >= CLIMB_GRADE_PCT - GRADE_HYSTERESIS_PCT,
    );
    this.descentSince = this.hold(
      this.descentSince,
      now,
      sample.gradePct <= DESCENT_GRADE_PCT,
      sample.gradePct <= DESCENT_GRADE_PCT + GRADE_HYSTERESIS_PCT,
    );
    this.lastSample = sample;
    this.lastNow = now;
  }

  /** You just finished a segment: the rider will tell the result soon. */
  queueSegment(now: number, event: SegmentEvent) {
    this.pruneSegments(now);
    this.segments.push({ at: now, event });
  }

  /** The remark to make right now, or null. The callbacks are only called when there is something to say. */
  poll(now: number, getLanguage: () => string, getRoute?: () => string | null) {
    const told = this.pollSegment(now, getLanguage) ?? this.pollBurst(now, getLanguage);

    if (told !== null) return told;
    const sample = this.lastSample;

    if (!sample || sample.timeS < MIN_RIDE_S) return null;

    if (this.lastRemark !== null && now - this.lastRemark < this.gap) return null;
    let route: string | null = null;
    let kind = this.dueKind(now, sample, now < this.routeRetryAt);

    if (kind === 'route') {
      route = getRoute?.() ?? null;

      if (!route) {
        this.routeRetryAt = now + ROUTE_RETRY_S;
        kind = this.dueKind(now, sample, true);
      }
    }

    if (kind === null) return null;
    const text = this.safely(() => this.render(kind, getLanguage(), sample, route));
    this.mark(kind, now, sample);

    if (text !== null) this.lastRemark = now;

    return text;
  }

  /** A rider that gives a hand signal ('elbow', 'hammer', ...) may say a line with it; `force` = always. */
  gestureQuip(now: number, gesture: string, getLanguage: () => string, chance = GESTURE_QUIP_CHANCE, force = false) {
    const kind = `gesture_${gesture}`;

    if (this.templates.values().every((pool) => !pool.texts.get(kind)?.length)) return null;

    if (!force) {
      if (chance <= 0 || this.rng.value() >= chance) return null;

      if (this.lastQuip !== null && now - this.lastQuip < GESTURE_QUIP_SPACING_S) return null;
    }

    let language = getLanguage();

    if (!this.templates.get(language)?.texts.get(kind)?.length) language = DEFAULT_LANGUAGE;
    const options = this.templates.get(language)?.texts.get(kind);

    if (!options?.length) return null;
    this.lastQuip = now;

    return this.pick(language, kind, options);
  }

  private resetRide() {
    this.powerSum = 0;
    this.powerTime = 0;
    this.window = [];
    this.routeRetryAt = 0;
    this.zone = null;
    this.zoneSince = null;
    this.short = [];
    this.burstSince = null;
    this.burstPeak = 0;
    this.pendingBurst = null;
    this.lastBurstEnd = null;
    this.lastSample = null;
    this.lastNow = null;
    this.timeDoneMin = 0;
    this.distanceDoneKm = 0;
    this.climbSince = null;
    this.descentSince = null;
    this.said = new Map();
    this.routeSaid = false;
  }

  /** What is already behind you at the first packet of a ride is not announced again. */
  private seed(sample: Sample) {
    this.timeDoneMin = step(Math.floor(sample.timeS / 60), TIME_STEP_MIN);
    this.distanceDoneKm = step(Math.floor(sample.distanceM / 1000), DISTANCE_STEP_KM);
    this.routeSaid = sample.timeS >= ROUTE_AFTER_S;
  }

  private pedallingSeconds() {
    return this.window.reduce((sum, entry) => sum + entry.seconds, 0);
  }

  /** Average power of the last minute while pedalling. */
  private windowPower() {
    const seconds = this.pedallingSeconds();

    return seconds > 0
      ? Math.round(this.window.reduce((sum, entry) => sum + entry.power * entry.seconds, 0) / seconds)
      : 0;
  }

  private hold(since: number | null, now: number, entering: boolean, staying: boolean) {
    if (since === null) return entering ? now : null;

    return staying ? since : null;
  }

  private updateEffortZone(now: number, sample: Sample) {
    const zone =
      sample.ftp > 0 && this.pedallingSeconds() >= EFFORT_MIN_PEDALLING_S
        ? effortZone(this.windowPower() / sample.ftp)
        : null;

    if (zone === this.zone) return;
    this.zone = zone;
    this.zoneSince = zone ? now : null;
  }

  /** A burst is 20 to 120 seconds at 110% of FTP or more; when it ends the rider asks how it went. */
  private updateBurst(now: number, sample: Sample) {
    this.short.push({ at: now, power: Math.max(sample.power, 0) });
    this.short = this.short.filter((entry) => now - entry.at <= BURST_SHORT_WINDOW_S);

    if (sample.ftp <= 0) {
      this.burstSince = null;

      return;
    }

    if (this.short.length < BURST_MIN_SAMPLES) return;
    const ratio = this.short.reduce((sum, entry) => sum + entry.power, 0) / this.short.length / sample.ftp;

    if (this.burstSince === null) {
      if (ratio >= BURST_START_RATIO) {
        this.burstSince = now;
        this.burstPeak = ratio;
      }

      return;
    }

    this.burstPeak = Math.max(this.burstPeak, ratio);

    if (ratio >= BURST_END_RATIO) return;
    const duration = now - this.burstSince;
    this.burstSince = null;

    const counts =
      duration >= BURST_MIN_S &&
      duration <= BURST_MAX_S &&
      (this.lastBurstEnd === null || now - this.lastBurstEnd >= BURST_COOLDOWN_S);

    if (!counts) return;
    this.pendingBurst = { at: now, seconds: Math.trunc(duration), percent: Math.round(this.burstPeak * 100) };
    this.lastBurstEnd = now;
  }

  private pollBurst(now: number, getLanguage: () => string) {
    const pending = this.pendingBurst;
    this.pendingBurst = null;

    if (!pending || now - pending.at > BURST_TTL_S) return null;

    const text = this.safely(() =>
      this.render('burst_end', getLanguage(), this.lastSample, null, { secs: pending.seconds, pct: pending.percent }),
    );

    if (text !== null) this.lastRemark = now;

    return text;
  }

  private pruneSegments(now: number) {
    this.segments = this.segments.filter((entry) => now - entry.at <= SEGMENT_EVENT_TTL_S);
  }

  private pollSegment(now: number, getLanguage: () => string) {
    this.pruneSegments(now);

    if (this.lastSegmentSaid !== null && now - this.lastSegmentSaid < SEGMENT_SPACING_S) return null;

    while (this.segments.length > 0) {
      const entry = this.segments.shift();
      const event = entry?.event;

      if (!event) break;
      const text = this.safely(() => this.renderSegment(event, getLanguage()));

      if (text !== null) {
        this.lastRemark = now;
        this.lastSegmentSaid = now;

        return text;
      }
    }

    return null;
  }

  private renderSegment(event: SegmentEvent, requested: string) {
    let language = requested;

    if (!this.templates.get(language)?.texts.get('segment_first')?.length) language = DEFAULT_LANGUAGE;
    const pool = this.templates.get(language);
    const best = event.previousMs.length > 0 ? Math.min(...event.previousMs) : event.elapsedMs;
    let kind = 'segment_slower';

    if (event.previousMs.length === 0) kind = 'segment_first';
    else if (Math.abs(event.elapsedMs - best) < SAME_TIME_MS) kind = 'segment_same';
    else if (event.elapsedMs < best) kind = 'segment_pb';
    const options = pool?.texts.get(kind);

    if (!options?.length) return null;
    const comma = DECIMAL_COMMA.has(language);

    return fill(this.pick(language, kind, options), {
      name: event.name,
      label: pool?.segmentKinds[event.kind] ?? event.kind,
      time: formatTime(event.elapsedMs, comma),
      power: event.avgPower,
      diff: formatTime(Math.abs(event.elapsedMs - best), comma),
      best: formatTime(best, comma),
    });
  }

  private dueKind(now: number, sample: Sample, skipRoute = false) {
    if (!skipRoute && !this.routeSaid && sample.timeS >= ROUTE_AFTER_S) return 'route';

    if (step(Math.floor(sample.timeS / 60), TIME_STEP_MIN) > this.timeDoneMin) return 'time';

    if (step(Math.floor(sample.distanceM / 1000), DISTANCE_STEP_KM) > this.distanceDoneKm) return 'distance';

    if (
      this.climbSince !== null &&
      now - this.climbSince >= CLIMB_HOLD_S &&
      this.cooledDown('climb', now, GRADE_COOLDOWN_S)
    )
      return 'climb';

    if (
      this.descentSince !== null &&
      now - this.descentSince >= DESCENT_HOLD_S &&
      this.cooledDown('descent', now, GRADE_COOLDOWN_S)
    )
      return 'descent';

    const effort = this.effortKind(now);

    if (effort !== null) return effort;

    // With a known FTP the effort zones say it better.
    return sample.ftp <= 0 ? this.trendKind(now, sample) : null;
  }

  private effortKind(now: number) {
    const zone = this.zone;

    if (
      zone === null ||
      this.zoneSince === null ||
      now - this.zoneSince < EFFORT_HOLD_S[zone] ||
      !this.cooledDown(`effort_${zone}`, now, EFFORT_COOLDOWN_S[zone]) ||
      !this.cooledDown('effort', now, EFFORT_ANY_COOLDOWN_S)
    )
      return null;

    return `effort_${zone}`;
  }

  private trendKind(now: number, sample: Sample) {
    if (
      sample.timeS < TREND_MIN_RIDE_S ||
      this.averagePower <= 0 ||
      this.pedallingSeconds() < TREND_MIN_PEDALLING_S ||
      !this.cooledDown('trend', now, TREND_COOLDOWN_S)
    )
      return null;
    const ratio = this.windowPower() / this.averagePower;

    if (ratio >= TREND_STRONGER) return 'stronger';

    return ratio <= TREND_WEAKER ? 'weaker' : null;
  }

  private cooledDown(group: string, now: number, cooldown: number) {
    const at = this.said.get(group);

    return at === undefined || now - at >= cooldown;
  }

  private mark(kind: string, now: number, sample: Sample) {
    switch (kind) {
      case 'route': {
        this.routeSaid = true;

        break;
      }

      case 'time': {
        this.timeDoneMin = step(Math.floor(sample.timeS / 60), TIME_STEP_MIN);

        break;
      }

      case 'distance': {
        this.distanceDoneKm = step(Math.floor(sample.distanceM / 1000), DISTANCE_STEP_KM);

        break;
      }

      case 'climb':
      case 'descent': {
        this.said.set(kind, now);

        break;
      }

      default: {
        // effort_<zone> and the trend
        this.said.set(kind.startsWith('effort_') ? kind : 'trend', now);

        if (kind.startsWith('effort_')) this.said.set('effort', now);
      }
    }
  }

  /** A broken template is logged by the caller as no text; it must never stop the ride. */
  private safely(make: () => string | null) {
    try {
      return make();
    } catch {
      return null;
    }
  }

  /** Every text is used once before any comes again, and a round never starts with the last text of the previous. */
  private pick(language: string, kind: string, options: readonly string[]) {
    const key = `${language}/${kind}`;
    let unused = this.unused.get(key);

    if (!unused?.length) {
      unused = options
        .map((text) => ({ text, key: this.rng.value() }))
        .toSorted((a, b) => a.key - b.key)
        .map(({ text }) => text);

      if (unused.length > 1 && unused.at(-1) === this.lastPick.get(key)) {
        const tail = unused.pop();

        if (tail !== undefined) unused.unshift(tail);
      }

      this.unused.set(key, unused);
    }

    const text = unused.pop() ?? options[0] ?? '';
    this.lastPick.set(key, text);

    return text;
  }

  private render(kind: string, requested: string, sample: Sample | null, route: string | null, extra: Values = {}) {
    if (!sample) return null;
    let language = requested;

    if (!this.templates.get(language)?.texts.get(kind)?.length) language = DEFAULT_LANGUAGE;
    const pool = this.templates.get(language);
    const options = pool?.texts.get(kind);

    if (!pool || !options?.length) return null;
    const decimal = (text: string) => (DECIMAL_COMMA.has(language) ? text.replace('.', ',') : text);
    const power = this.windowPower();

    const base = {
      min: Math.floor(sample.timeS / 60),
      km: decimal(formatKm(sample.distanceM)),
      avg: this.averagePower,
      power,
      hr: sample.heartrate,
      grade: decimal(sample.gradePct.toFixed(1)),
      climbed: sample.climbedM,
      route: route ?? '',
      ftp: sample.ftp,
      pct: sample.ftp > 0 ? Math.round((power * 100) / sample.ftp) : 0,
      ...extra,
    };

    const heartrate = sample.heartrate > 0 && pool.heartrate ? fill(pool.heartrate, base) : '';

    return fill(this.pick(language, kind, options), { ...base, hr_text: heartrate });
  }
}
