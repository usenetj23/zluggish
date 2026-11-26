import { t } from '#src/i18n/index';
import { Option, Schema } from 'effect';

/**
The free-form object a Sauce mod keeps per athlete (its lap sets, its segment results, its own
counters). The Sauce server hands the very same object back to every widget of that rider's page;
Zluggish keeps it in memory only, scoped to the signed-in viewer that wrote it, so it never turns
into a second athlete profile and a restarted server simply starts empty again. Pure bookkeeping:
no world, no socket and no clock is touched here, so a test can check it on its own.

Nothing stored is ever mutated in place: an update builds a new object and replaces the old one, so
an answer already handed to a caller can never change underneath it.
*/

/** How many athletes one viewer may keep data for; the athlete written longest ago gives its seat up. */
export const maxAthletesPerViewer = 40;

/** How many viewers the store holds at all; the viewer written longest ago is dropped whole. */
export const maxViewers = 500;

/** How large one athlete's data may be once serialized; a mod that keeps appending is refused. */
export const maxAthleteDataBytes = 32 * 1024;

/** Why the store refused an update. */
export type AthleteDataReject = 'not-an-object' | 'forbidden-key' | 'too-large';

/** A refused update: the route turns it into a 400 `ArgumentError` and shows `detail` to the page. */
export class AthleteDataError extends TypeError {
  public constructor(
    public readonly reason: AthleteDataReject,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = 'AthleteDataError';
  }
}

/** Keys that must never be written into a plain object: they would reach the prototype chain. */
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** One value a mod keeps: anything JSON can carry. */
export type AthleteDataValue = typeof Schema.Json.Type;

/** The object a mod keeps about one athlete. */
export type AthleteData = Readonly<Record<string, AthleteDataValue>>;

/** A plain JSON object: not an array, not null, not a scalar. */
const decodeData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

export class AthleteDataStore {
  /** The data of every viewer, one athlete-keyed map each, both in write order (oldest first). */
  private readonly held = new Map<number, Map<number, AthleteData>>();

  /** How many viewers are tracked right now. */
  public get size(): number {
    return this.held.size;
  }

  /**
  Shallow-merges `data` over what this viewer holds of `athleteId` and answers the merged object; a
  key given as null is deleted. The stored object is replaced, never touched. A forbidden key, a
  value that is no JSON object and a result past the size limit each raise `AthleteDataError`
  without storing anything.
  */
  public update(viewerId: number, athleteId: number, data: unknown): AthleteData {
    const given = Option.getOrUndefined(decodeData(data));

    if (given === undefined || Array.isArray(data)) {
      throw new AthleteDataError('not-an-object', t('athlete_data_not_object'));
    }

    if (Object.keys(given).some((key) => forbiddenKeys.has(key))) {
      throw new AthleteDataError('forbidden-key', t('athlete_data_forbidden_key'));
    }

    this.withinLimit(given);

    const athletes = this.held.get(viewerId) ?? new Map<number, AthleteData>();
    const values = new Map(Object.entries(athletes.get(athleteId) ?? {}));

    for (const [key, value] of Object.entries(given)) {
      if (value === null) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }

    const merged = Object.fromEntries(values);

    this.withinLimit(merged);

    // Re-setting replaces the entry: a Map keeps insertion order, so one write moves both the athlete
    // and its viewer to the newest seat and the oldest one is the first to go.
    athletes.delete(athleteId);
    athletes.set(athleteId, merged);

    this.held.delete(viewerId);
    this.held.set(viewerId, athletes);

    if (athletes.size > maxAthletesPerViewer) {
      const oldest = athletes.keys().next();

      if (!oldest.done) {
        athletes.delete(oldest.value);
      }
    }

    if (this.held.size > maxViewers) {
      const oldestViewer = this.held.keys().next();

      if (!oldestViewer.done) {
        this.held.delete(oldestViewer.value);
      }
    }

    return Object.fromEntries(values);
  }

  /** What this viewer's mods keep of `athleteId`: the stored object itself (never mutated, see `update`), or undefined. */
  public get(viewerId: number, athleteId: number): AthleteData | undefined {
    return this.held.get(viewerId)?.get(athleteId);
  }

  /** The size gate of one object, serialized; an unserialisable value is no data at all. */
  private withinLimit(of: AthleteData): void {
    let serialized: string;

    try {
      serialized = JSON.stringify(of);
    } catch {
      throw new AthleteDataError('not-an-object', t('athlete_data_not_json'));
    }

    if (Buffer.byteLength(serialized, 'utf8') > maxAthleteDataBytes) {
      throw new AthleteDataError('too-large', t('athlete_data_too_large', { value1: maxAthleteDataBytes }));
    }
  }
}
