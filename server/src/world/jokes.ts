import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { Random } from '#src/world/geometry';
import { create, toBinary } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const DEFAULT_LANGUAGE = 'en';

/** The language of the jokes for the flag of a rider's profile (ISO 3166 numeric country code). */
const COUNTRY_LANGUAGE = new Map([[616, 'pl']]);

/** The next joke comes after the interval times a random factor between 0.5 and 1.5. */
const INTERVAL_SPREAD = 0.5;

/** What a chat message of the game lives for. */
const CHAT_EXPIRE_MS = 60_000n;

export type Jokes = ReadonlyMap<string, readonly string[]>;

/** Jokes by language, from data/jokes.txt: `{ "en": ["...", ...], "pl": [...] }`. Blank jokes are dropped. */
export function loadJokes(assets: string): Jokes {
  const file = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(readFileSync(resolve(assets, 'data/jokes.txt'), 'utf8')));

  const jokes = new Map<string, readonly string[]>();

  for (const [language, items] of Object.entries(file)) {
    const clean = items.map((joke) => joke.trim()).filter(Boolean);

    if (clean.length > 0) jokes.set(language.toLowerCase(), clean);
  }

  return jokes;
}

/** The language to tell jokes in: `auto` follows the flag of the rider, anything else names a language.
Falls back to English when there are no jokes in the wanted language.
*/
export function resolveLanguage(setting: string, countryCode: number, available: ReadonlyMap<string, unknown>) {
  const wanted = setting === 'auto' ? (COUNTRY_LANGUAGE.get(countryCode) ?? DEFAULT_LANGUAGE) : setting.toLowerCase();

  return available.has(wanted) ? wanted : DEFAULT_LANGUAGE;
}

/** Decides when the next joke is due and which one: nothing repeats until a language's list has been told. */
export class JokeTeller {
  private readonly unused = new Map<string, string[]>();

  private readonly last = new Map<string, string>();

  private next = 0;

  constructor(
    private readonly rng: Random,
    private readonly jokes: Jokes,
    private readonly interval: number,
    now: number,
  ) {
    this.reset(now);
  }

  /** Whatever was said, the next joke is a full wait away. */
  reset(now: number) {
    this.next = now + this.wait();
  }

  /** True when the next joke is ready; nothing is used up. */
  due(now: number) {
    return this.interval > 0 && now >= this.next;
  }

  /** The joke to tell right now, or null. */
  poll(now: number, language: string) {
    if (!this.due(now)) return null;
    const joke = this.pick(language);

    if (joke === null) return null;
    this.next = now + this.wait();

    return joke;
  }

  private wait() {
    return this.interval * this.rng.between(1 - INTERVAL_SPREAD, 1 + INTERVAL_SPREAD);
  }

  private pick(language: string) {
    const pool = this.jokes.get(language);

    if (!pool?.length) return null;
    let unused = this.unused.get(language);

    if (!unused?.length) {
      unused = this.shuffled(pool);

      // A new round does not start with the joke that ended the last one.
      if (unused.length > 1 && unused.at(-1) === this.last.get(language)) {
        const tail = unused.pop();

        if (tail !== undefined) unused.unshift(tail);
      }

      this.unused.set(language, unused);
    }

    const joke = unused.pop() ?? null;

    if (joke !== null) this.last.set(language, joke);

    return joke;
  }

  private shuffled(pool: readonly string[]) {
    return pool
      .map((joke) => ({ joke, key: this.rng.value() }))
      .toSorted((a, b) => a.key - b.key)
      .map(({ joke }) => joke);
  }
}

/** A chat message `text` from the rider `firstName` `lastName`, as the game shows it in the chat panel. */
export function chatUpdate(text: string, firstName: string, lastName: string, time: bigint) {
  const action = create(SocialPlayerActionSchema, {
    playerId: 0n,
    toPlayerId: 0n,
    spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
    firstName,
    lastName,
    message: text,
    countryCode: 0,
  });

  return create(WorldAttributeSchema, {
    serverRealm: 1n,
    waType: WA_TYPE.WAT_SPA,
    worldTimeBorn: time,
    worldTimeExpire: time + CHAT_EXPIRE_MS,
    waF12: 1n,
    timestamp: BigInt(Date.now()) * 1000n,
    payload: toBinary(SocialPlayerActionSchema, action),
  });
}
