import { readFileSync, statSync } from 'node:fs';
import { countryNumeric } from '#src/world/country-codes';

/** A photo credit; every part is present because a partial credit is not publishable. */
export interface BotPhoto {
  url: string;
  author: string;
  license: string;
  source: string;
}

/** Everything the game knows about one bot rider. */
export interface BotProfile {
  name: string;
  countryName: string | null;
  countryCode: number | null;
  teamName: string | null;
  teamWebsite: string | null;
  born: string | null;
  birthplace: string | null;
  bio: string | null;
  photo: BotPhoto | null;
  wikidata: string | null;
}

const BIO_MAX = 400;

const TEXT_MAX = 200;

const WIKIDATA_PATTERN = /^Q\d+$/;

const BORN_PATTERN = /^\d{4}(-\d\d-\d\d)?$/;

const HTTPS_PREFIX = 'https://';

const PHOTO_HOSTS = new Set(['commons.wikimedia.org', 'upload.wikimedia.org', 'static.cyclingdb.com']);

/** A region name as reported for Kosovo when the local ICU data does not know the code. */
const FALLBACK_REGION_NAMES: ReadonlyMap<string, string> = new Map([['XK', 'Kosovo']]);

/** A value of a parsed JSON document. */
type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;

/** An object of a parsed JSON document. */
type JsonObject = { readonly [key: string]: JsonValue };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string, cut to `max` characters, or null when the value is not usable text. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A public web address, or null. */
function website(value: unknown): string | null {
  const candidate = text(value, TEXT_MAX);

  return candidate !== null && candidate.startsWith(HTTPS_PREFIX) ? candidate : null;
}

/** An ISO date: a bare year, or a full date that survives a Date.UTC round trip. */
function born(value: unknown): string | null {
  const candidate = text(value, TEXT_MAX);

  if (candidate === null || !BORN_PATTERN.test(candidate)) {
    return null;
  }

  if (candidate.length === 4) {
    return candidate;
  }

  const parts = candidate.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }

  const stamp = Date.UTC(year, month - 1, day);

  if (Number.isNaN(stamp)) {
    return null;
  }

  const date = new Date(stamp);

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return candidate;
}

/** A two-letter country code turned into an English region name, or null. */
function countryName(value: unknown): string | null {
  const code = text(value, 2);

  if (code === null || !/^[A-Z]{2}$/.test(code)) {
    return null;
  }

  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);

    if (typeof name === 'string' && name !== '' && name !== code) {
      return name;
    }
  } catch {
    // Fall through to the fallback table below.
  }

  return FALLBACK_REGION_NAMES.get(code) ?? code;
}

/** A Wikimedia photo with a complete credit, or null. */
function photo(value: unknown): BotPhoto | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = text(value['url'], TEXT_MAX);
  const author = text(value['author'], TEXT_MAX);
  const license = text(value['license'], TEXT_MAX);
  const source = website(value['source']);

  if (url === null || author === null || license === null || source === null) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || !PHOTO_HOSTS.has(parsed.hostname)) {
    return null;
  }

  return { url, author, license, source };
}

function wikidata(value: unknown): string | null {
  const candidate = text(value, TEXT_MAX);

  return candidate !== null && WIKIDATA_PATTERN.test(candidate) ? candidate : null;
}

interface RawTeam {
  name: string | null;
  website: string | null;
}

interface RawRider {
  name: string;
  pcs: string | null;
  countryName: string | null;
  countryCode: number | null;
  teamCode: string | null;
  born: string | null;
  birthplace: string | null;
  bio: string | null;
  photo: BotPhoto | null;
  wikidata: string | null;
}

function readTeams(value: unknown): Map<string, RawTeam> {
  const teams = new Map<string, RawTeam>();

  if (!isRecord(value)) {
    return teams;
  }

  for (const [code, entry] of Object.entries(value)) {
    if (code.trim() === '' || !isRecord(entry)) {
      continue;
    }

    teams.set(code, { name: text(entry['name'], TEXT_MAX), website: website(entry['website']) });
  }

  return teams;
}

function readRider(value: unknown): RawRider | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = text(value['name'], TEXT_MAX);

  if (name === null) {
    return null;
  }

  return {
    name,
    pcs: text(value['pcs'], TEXT_MAX),
    countryName: countryName(value['country']),
    countryCode: countryNumeric(value['country']),
    teamCode: text(value['team'], TEXT_MAX),
    born: born(value['born']),
    birthplace: text(value['birthplace'], TEXT_MAX),
    bio: text(value['bio'], BIO_MAX),
    photo: photo(value['photo']),
    wikidata: wikidata(value['wikidata']),
  };
}

function mergePhoto(current: BotPhoto | null, incoming: BotPhoto | null): BotPhoto | null {
  return current ?? incoming;
}

function mergedProfile(name: string, group: ReadonlyArray<RawRider>, teams: ReadonlyMap<string, RawTeam>): BotProfile {
  const first = (pick: (rider: RawRider) => string | null): string | null => {
    for (const rider of group) {
      const value = pick(rider);

      if (value !== null) {
        return value;
      }
    }

    return null;
  };

  const firstCountryCode = (): number | null => {
    for (const rider of group) {
      if (rider.countryCode !== null) {
        return rider.countryCode;
      }
    }

    return null;
  };

  const teamCode = first((rider) => rider.teamCode);
  const team = teamCode === null ? undefined : teams.get(teamCode);

  let photo: BotPhoto | null = null;

  for (const rider of group) {
    photo = mergePhoto(photo, rider.photo);
  }

  return {
    name,
    countryName: first((rider) => rider.countryName),
    countryCode: firstCountryCode(),
    teamName: team?.name ?? null,
    teamWebsite: team?.website ?? null,
    born: first((rider) => rider.born),
    birthplace: first((rider) => rider.birthplace),
    bio: first((rider) => rider.bio),
    photo,
    wikidata: first((rider) => rider.wikidata),
  };
}

/**
The bot rider facts: every rider reachable by the exact `"<firstName> <lastName>"` name, riders
sharing one pcs identity merged into a single profile.
*/
export class BotProfiles {
  private constructor(private readonly profiles: ReadonlyMap<string, BotProfile>) {}

  static empty(): BotProfiles {
    return new BotProfiles(new Map());
  }

  /** Reads the JSON document; every malformed part degrades to null, every bad rider is skipped. */
  static parse(value: string): BotProfiles {
    let document: unknown;

    try {
      document = JSON.parse(value);
    } catch {
      return BotProfiles.empty();
    }

    if (!isRecord(document)) {
      return BotProfiles.empty();
    }

    const teams = readTeams(document['teams']);
    const riders = Array.isArray(document['riders']) ? document['riders'] : [];
    const accepted: Array<RawRider> = [];

    for (const entry of riders) {
      const rider = readRider(entry);

      if (rider !== null) {
        accepted.push(rider);
      }
    }

    const groups = new Map<string, Array<RawRider>>();

    for (const rider of accepted) {
      const key = rider.pcs === null ? `name:${rider.name}` : `pcs:${rider.pcs}`;
      const group = groups.get(key);

      if (group === undefined) {
        groups.set(key, [rider]);
      } else {
        group.push(rider);
      }
    }

    const profiles = new Map<string, BotProfile>();

    for (const group of groups.values()) {
      const names: Array<string> = [];

      for (const rider of group) {
        if (!names.includes(rider.name)) {
          names.push(rider.name);
        }
      }

      for (const name of names) {
        const profile = mergedProfile(name, group, teams);

        if (!profiles.has(name)) {
          profiles.set(name, profile);
        }
      }
    }

    return new BotProfiles(profiles);
  }

  get(firstName: string, lastName: string): BotProfile | undefined {
    return this.profiles.get(`${firstName} ${lastName}`);
  }

  get size(): number {
    return this.profiles.size;
  }
}

/** Loads `path`; a missing, unreadable or unparseable file yields an empty catalogue. */
export function loadBotProfiles(path: string): BotProfiles {
  try {
    return BotProfiles.parse(readFileSync(path, 'utf8'));
  } catch {
    return BotProfiles.empty();
  }
}

/**
A lazy view of `path`: the first call loads the file, later calls reload only when the file has
changed, and the file is stat'ed at most every `recheckMs` milliseconds.
*/
export function watchBotProfiles(path: string, now: () => number = Date.now, recheckMs = 5000): () => BotProfiles {
  let catalogue: BotProfiles | undefined;
  let lastChecked = 0;
  let signature = '';

  return (): BotProfiles => {
    if (catalogue === undefined || now() - lastChecked >= recheckMs) {
      lastChecked = now();

      let next: string;

      try {
        const stats = statSync(path);

        next = `${stats.mtimeMs}:${stats.size}`;
      } catch {
        next = 'missing';
      }

      if (catalogue === undefined || next !== signature) {
        signature = next;
        catalogue = loadBotProfiles(path);
      }
    }

    return catalogue;
  };
}
