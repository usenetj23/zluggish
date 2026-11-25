/**
Assembly of the Sauce for Zwift records from what Zluggish already holds: a rider packet, the rolling
statistics of `world/live-stats` and the neighbourhood arithmetic of `world/relations`. Everything here
is pure, with no access to the world, the socket or the clock, so a route module serving
`/api/ws/events` can call it once per push and a test can check the same numbers.
*/

import { POWERUP_TYPES } from '#src/world/powerups';
import type {
  WidgetAthleteInfo,
  WidgetAthleteState,
  WidgetGroupRecord,
  WidgetLapSummary,
  WidgetNearbyRecord,
  WidgetStatsMetric,
  OverlayRelation,
} from '#src/dtos/widget-api.dto';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { Sport } from '#src/protocol/generated/profile_pb';
import { proCyclingStatsUrl } from '#src/world/pro-cycling-stats';
import { isBotId } from '#src/world/peloton';
import type { BotProfiles } from '#src/world/bot-profiles';
import { defaultWPrime } from '#src/world/wbal';
import { equipmentOf } from '#src/world/equipment';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import type { LapSnapshot, PeriodAverage, StatsSnapshot } from '#src/world/live-stats';
import { peakPeriods, RiderStats } from '#src/world/live-stats';
import type { NearbyEntry, RiderGroup } from '#src/world/relations';
import { course, forward, millimetresPerHourToKmPerHour, road } from '#src/world/state';

/** The altitude the packet carries is in centimetres; Sauce reports metres. */
const centimetresToMetres = 100;

/** `roadTime` starts with this much grace, which is how Sauce computes its road completion. */
const roadCompletionOffset = 5000;

/** Characters a widget page would hand to the DOM along with the name it shows. */
const markupCharacters = /[<>&"']/g;

/** The name a page can print: trimmed and without anything that could be read as markup. */
const sanitize = (value: string): string => value.trim().replaceAll(markupCharacters, '');

/** The capitalised first letter of a name; nothing when the name is missing altogether. */
const initialOf = (name: string): string => (name.length === 0 ? '' : name.slice(0, 1).toUpperCase());

/** A number the wire can carry: a packet value that is not finite is reported as 0. */
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
Pro-level power-to-weight threshold, in W/kg, that the FTP a BOT rider is shown with is built from.
Bots are public pro riders but the privacy rule hands their stored FTP to other viewers as 0, which
would colour every bot in the top power zone no matter how hard it actually rides; a displayed FTP of
weight x this constant puts ordinary pro riding at 2-3 W/kg into zones 1-2 instead. Real riders are
never touched by this: their FTP keeps going through `forViewer`.
*/
export const botFtpWattsPerKg = 6;

/** The weight a bot profile is assumed to ride at when it carries none (kg). */
const botDefaultWeightKg = 70;

/**
The FTP a rider's athlete record shows: for a bot rider the pro-level display value built from its
weight (see `botFtpWattsPerKg`), for a real rider exactly the FTP it was handed, which the caller has
already passed through the privacy rule.
*/
const displayedFtp = (id: number, profile: PlayerProfile): number => {
  if (!isBotId(id)) {
    return profile.ftp;
  }

  const grams = profile.weightInGrams;
  const weightKg = Number.isFinite(grams) && grams > 0 ? grams / 1000 : botDefaultWeightKg;

  return Math.round(weightKg * botFtpWattsPerKg);
};

/**
The NUMERIC country code (ISO 3166-1 numeric, the number the Zwift profile carries in
`profile.countryCode`) the page turns into a flag: for a bot rider the code of its catalogue country
(converted in `world/bot-profiles`), for a real rider the profile's own code, reported only when it
is a finite integer above 0 (0 is the "no country" default of the profile).
*/
const athleteCountryCode = (
  id: number,
  profile: PlayerProfile,
  facts?: { countryCode: number | null },
): number | null => {
  if (isBotId(id)) {
    return facts?.countryCode ?? null;
  }

  return Number.isSafeInteger(profile.countryCode) && profile.countryCode > 0 ? profile.countryCode : null;
};

/**
The direction of travel as the Geo/Map page wants it: degrees in [0, 360).

The protocol field `state.heading` is an int64 holding radians times 1e6 in [0, 2π), measured in the
game's x/z frame. The page works in an x/y frame whose y axis is our `z` flipped relative to the
game's travel convention, so the travel direction in the page's frame is π − raw; the page then
wants `heading = -travel angle` in degrees, which is `raw + π` in degrees. The `+ 180` below is that
π. A value that is not finite (a packet without the field, parsed as NaN) becomes 0.
*/
export function headingDegrees(raw: bigint | number): number {
  const degrees = ((Number(raw) / 1_000_000) * 180) / Math.PI + 180;

  return Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : 0;
}

/** The arithmetic mean of a pack metric; 0 for an empty pack, which never happens in practice. */
const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
Identity of a rider as the `athlete` sub-object shows it. The avatar and the team are not
part of what the world state carries for another rider, so they stay empty; the `countryCode` is the
numeric country code (see `athleteCountryCode`). `wPrime` is the capacity
the W' balance is computed with (see `nearbyRecord`) and stays 0 whenever no balance is being
computed; the remaining power model field (`cp`) and the local-only flags (`follower`,
`followRequest`) stay at their neutral values; so do the age, the height and the
two racing fields (`racingScore`, `racingCategory`), which zluggish does not model. The three flags
of the viewer's own stance towards the rider (`marked`, `following`, `muted`) come from `relation`:
they are the viewer's own state, kept by the server per viewer (the `overlay_relation` table), and
the other riders' viewers never see them, so they stay false whenever no relation is handed over.
`type` is always
`NORMAL`: zluggish knows no special rider kinds. `externalProfile` links a bot rider (see `isBotId`)
to its ProCyclingStats page built from the rider's names, and is null for real riders, whose public
profile stays on ZwiftPower. `bot` carries the catalogue facts of `world/bot-profiles` for a bot rider
that the catalogue knows (null when `botProfiles` is not handed over, when the bot is absent from it or
for a real rider); its `photo` carries only the credits, because the photo itself is served by
`/api/bot-photo/<id>` and the Wikimedia address stays on the server, and such a bot's `avatar` is
that same-origin address. `equipment` is the Zwift 2.4 addition to athlete objects (see
`world/equipment`): it is present only when `frames` is handed over AND the profile actually rides a
bike frame or runs shoes, so an athlete of a profile with neither carries no `equipment` key at all.
None of these new fields carries anything private:
another rider's `ftp` and `weight` still reach a viewer only through `forViewer`. One display
exception: a BOT rider's `ftp` is shown as `botFtpWattsPerKg` times its weight instead of the stored
(privacy-gated, hence 0) value, so the pages colour a bot's power by a plausible pro FTP rather than
painting every bot in the top zone; a real rider's `ftp` is the value handed over, untouched.
*/
export function athleteInfo(
  id: number,
  profile: PlayerProfile,
  wPrime = 0,
  botProfiles?: BotProfiles,
  relation?: OverlayRelation,
  frames?: ReadonlyMap<number, string>,
): WidgetAthleteInfo {
  const first = sanitize(profile.firstName);
  const last = sanitize(profile.lastName);
  const statsUrl = isBotId(id) ? proCyclingStatsUrl(profile.firstName, profile.lastName) : null;
  // The catalogue facts of a bot rider: the whole entry minus its `name`, which the athlete record
  // already carries under its own keys; null for a real rider or a bot the catalogue does not know.
  const facts =
    isBotId(id) && botProfiles !== undefined ? botProfiles.get(profile.firstName, profile.lastName) : undefined;

  // The rider's equipment, only when the frame names were handed over and the profile actually rides
  // something: an empty object means no key at all, exactly as a Sauce athlete without equipment.
  const equipment = frames === undefined ? undefined : equipmentOf(profile, frames);

  const info: WidgetAthleteInfo = {
    id,
    // Sauce's athlete carries the names themselves too; mods (O101) read `athlete.firstName` and `lastName`.
    firstName: first,
    lastName: last,
    sanitizedFullname: `${first} ${last}`.trim(),
    fLast: first.length === 0 ? last : `${initialOf(first)}.${last}`,
    initials: `${initialOf(first)}${initialOf(last)}`,
    avatar: facts === undefined || facts.photo === null ? '' : `/api/bot-photo/${id}`,
    countryCode: athleteCountryCode(id, profile, facts),
    gender: profile.isMale ? 'male' : 'female',
    type: 'NORMAL',
    age: null,
    height: null,
    racingScore: null,
    racingCategory: null,
    // A string, never null: the pages call string methods on the team of a rider the moment the key exists.
    team: '',
    weight: profile.weightInGrams / 1000,
    // The profile carries the level times 100 (see the relay's level economy), and a level the page
    // cannot read is shown as 0.
    level: Number.isFinite(profile.achievementLevel) ? Math.floor(profile.achievementLevel / 100) : 0,
    ftp: displayedFtp(id, profile),
    cp: 0,
    wPrime,
    marked: relation?.marked ?? false,
    following: relation?.following ?? false,
    muted: relation?.muted ?? false,
    follower: false,
    followRequest: false,
    externalProfile: statsUrl === null ? null : { name: 'ProCyclingStats', url: statsUrl },
    bot:
      facts === undefined
        ? null
        : {
            countryName: facts.countryName,
            teamName: facts.teamName,
            teamWebsite: facts.teamWebsite,
            born: facts.born,
            birthplace: facts.birthplace,
            bio: facts.bio,
            wikidata: facts.wikidata,
            photo:
              facts.photo === null
                ? null
                : { author: facts.photo.author, license: facts.photo.license, source: facts.photo.source },
          },
  };

  return equipment === undefined || Object.keys(equipment).length === 0 ? info : { ...info, equipment };
}

/** Rounds to `places` decimals; modern pages print these values as they are. */
function round(value: number, places: number): number {
  const factor = 10 ** places;

  return Math.round(value * factor) / factor;
}

/**
Live ride state of a rider, straight from the packet. Fields the protocol does not carry at all are
zeros for v1: `eventDistance`, `progress`, `latency`, `activePowerUp` and the two
route checkpoint and decision indexes; a later revision can fill them from route and event state.
`rideons` is the count of Ride Ons the rider has been sent (`world/ride-on-count`, handed over by the
caller); a value that is not a whole non-negative number is shown as 0.
*/
export function athleteState(
  state: PlayerState,
  stats: StatsSnapshot,
  rideOns = 0,
  route?: { routeDistance: number; routeEnd: number },
): WidgetAthleteState {
  const altitude = finite(state.yAltitude / centimetresToMetres);

  const record = {
    sport: state.sport === Sport.RUNNING ? 'running' : 'cycling',
    eventSubgroupId: null,
    routeId: state.route === 0 ? null : state.route,
    distance: state.distance,
    // The Ride Ons the packet itself carries (the top byte of flags 1), or those this server counted, whichever is more.
    rideons: Math.max(state.f19 >>> 24, Number.isFinite(rideOns) && rideOns >= 0 ? Math.trunc(rideOns) : 0),
    kj: stats.power.kj,
    // The power meter flag is the lowest bit of byte 0 of f19: HasPowerMeter.
    powerMeter: (state.f19 & 1) === 0 ? 0 : 1,
    grade: round(finite(stats.grade), 4),
    altitude,
    // The position the Geo/Map page hands to `ent.setPosition([state.x, state.y])`: the packet's `x`
    // is the game's x coordinate and the game's other horizontal axis is the packet's `z` (see the
    // `pairOf` mapping in `world/streams`), so `y` is `state.z`; `z` is the altitude in metres, the
    // same value as `altitude` above. A non-finite packet value becomes 0 (the page would throw
    // `TypeError: invalid position` on NaN).
    x: finite(state.x),
    y: finite(state.z),
    z: altitude,
    heading: headingDegrees(state.heading),
    laps: state.laps,
    // The game's distance of the event in centimetres (it keeps counting on a free ride).
    eventDistance: finite(state.distLat / 100),
    // Route progress: bits 8..15 of the packet's `progress` hold it in whole percent.
    progress: ((state.progress >>> 8) & 0xff) / 0xff,
    // The workout mode the packet carries in the low 4 bits of its progress, null for none.
    workoutZone: state.progress & 0xf || null,
    roadId: road(state),
    // The position on the road in millionths, counted in the rider's direction.
    roadCompletion: forward(state)
      ? Math.max(0, state.roadTime - roadCompletionOffset)
      : Math.max(0, 1_005_000 - state.roadTime),
    roadTime: state.roadTime,
    power: state.power,
    speed: round(state.speed / millimetresPerHourToKmPerHour, 1),
    heartrate: state.heartrate,
    cadence: Math.round((state.cadenceUHz * 60) / 1_000_000),
    // The estimated watts saved in the slipstream of the rider in front (see `world/draft.ts`).
    draft: Math.round(stats.draft.current),
    time: state.time,
    reverse: !forward(state),
    courseId: course(state),
    latency: 0,
    // The low 4 bits of aux3 carry the type of the power-up the rider is under (the index into the names, 15 is none).
    activePowerUp: POWERUP_TYPES[state.aux3 & 0xf] ?? null,
    climbing: finite(state.climbing),
    worldTime: finite(Number(state.worldTime)),
    routeCheckpointIndex: state.psF36,
    routeDecisionIndex: state.psF37,
  };

  return route === undefined ? record : { ...record, ...route };
}

/**
The `stats` sub-object of a nearby record: the same rolling windows Zluggish already computes, under
the metric names and the `avg` plus `smooth` plus `peaks` shape the pages read.
*/
export function widgetStats(stats: StatsSnapshot): WidgetNearbyRecord['stats'] {
  return {
    activeTime: stats.activeTime,
    elapsedTime: stats.elapsedTime,
    power: {
      avg: stats.power.avg,
      smooth: stats.power.smooth,
      peaks: stats.power.peaks,
      np: stats.power.np,
      tss: stats.power.tss,
      max: stats.power.max,
      timeInZones: stats.timeInPowerZones,
    },
    np: { smooth: stats.npSmooth },
    speed: { avg: stats.speed.avg, smooth: stats.speed.smooth, peaks: stats.speed.peaks, max: stats.speed.max },
    hr: { avg: stats.hr.avg, smooth: stats.hr.smooth, peaks: stats.hr.peaks, max: stats.hr.max },
    cadence: { avg: stats.cadence.avg, max: stats.cadence.max },
    draft: {
      avg: stats.draft.avg,
      smooth: stats.draft.smooth,
      peaks: stats.draft.peaks,
      max: stats.draft.max,
      kj: stats.draft.kj,
    },
  };
}

/**
A lap as a nearby record shows it. `activeTime` exists on the current lap only, so the key is added
only then: Sauce's own records simply have no such key on `lastLap`.
*/
export function lapSummary(lap: LapSnapshot, withActiveTime: boolean): WidgetLapSummary {
  const averages = {
    power: { avg: lap.power.avg, max: lap.power.max },
    speed: { avg: lap.speed.avg, max: lap.speed.max },
    hr: { avg: lap.hr.avg, max: lap.hr.max },
    cadence: { avg: lap.cadence.avg, max: lap.cadence.max },
    draft: { avg: lap.draft.avg, max: lap.draft.max },
  };

  return withActiveTime ? { ...averages, activeTime: lap.activeTime } : averages;
}

/**
A nearby record as the pages read it: the DTO shape, which already models the `timeInPowerZones` the
Analysis and Watching pages read at the top level, next to `stats`.
*/
export type WidgetRiderRecord = WidgetNearbyRecord;

/**
One entry of the `nearby` stream: the gap from `relations`, the live state from the packet and the
statistics of that rider. A rider whose statistics we do not track is still shown, with zeros, which
is what a fresh or just entered neighbour looks like on Sauce too.

`ftp` is the statistics the caller was handed already taken at: the same FTP the snapshot carries, so
that the W' balance stays private (see the viewer rule in the routes). The top-level `wBal` is the
joules the model leaves of the default 20 kJ capacity, and the athlete's `wPrime` is that capacity;
both stay null and 0 for a rider whose FTP is not known to this viewer, which is every other rider.

`botProfiles` is the catalogue of bot rider facts (see `world/bot-profiles`); when it is handed over it
reaches the athlete record of a bot rider, exactly as `athleteInfo` describes. `relation` is the
viewer's own stance towards this rider (see `athleteInfo`); when absent the three flags stay false.
`frames` is the frame-name map of `world/equipment`; when handed over it lets the athlete record carry
the rider's `equipment`, exactly as `athleteInfo` describes. `age` is the milliseconds since the
rider's last packet, which the Geo/Map page reads to decide whether the rider is in game at all; the
view already filters stale states out (see `fresh` in `world/state`) and this module stays free of the
clock, so the caller that knows the age hands it over and the default 0 says "just seen". `rideOns` is
the Ride Ons this rider has been sent (see `world/ride-on-count`); the default 0 is a rider nobody has
Ride-Oned (yet).
*/
export function nearbyRecord(
  entry: NearbyEntry,
  state: PlayerState,
  stats: StatsSnapshot | undefined,
  profile: PlayerProfile,
  ftp?: number,
  botProfiles?: BotProfiles,
  relation?: OverlayRelation,
  frames?: ReadonlyMap<number, string>,
  age = 0,
  rideOns = 0,
  route?: { routeDistance: number; routeEnd: number },
): WidgetRiderRecord {
  const s = stats ?? new RiderStats().snapshot(ftp ?? profile.ftp);

  return {
    athleteId: entry.id,
    watching: entry.self,
    eventLeader: false,
    eventSweeper: false,
    gap: entry.gap,
    gapDistance: entry.gapDistance,
    isGapEst: entry.isGapEst,
    remaining: null,
    remainingMetric: null,
    eventPosition: null,
    lapCount: s.lapCount,
    wBal: s.power.wBal,
    stats: widgetStats(s),
    lap: lapSummary(s.lap, true),
    lastLap: lapSummary(s.lastLap, false),
    athlete: athleteInfo(entry.id, profile, s.power.wBal === null ? 0 : defaultWPrime, botProfiles, relation, frames),
    state: athleteState(state, s, rideOns, route),
    // The Analysis page reads these two at the TOP level: the course it hands to `zwiftMap.setCourse`
    // and the start of the ride it compares between polls to spot a data reset.
    courseId: course(state),
    created: s.created,
    // Also at the TOP level, next to `created`: the Geo/Map page treats a rider as not in game unless
    // this age stays below a minute, and the view only ever hands over fresh states, hence the 0.
    age,
    // Also at the TOP level, next to `stats`: the seconds of active riding per power zone, which the
    // Analysis and Watching pages show. Like the W' balance it is empty for a viewer who may not use
    // this rider's FTP, which is every other rider (the snapshot was taken at FTP 0 for them) and for
    // a rider with no FTP at all.
    timeInPowerZones: s.timeInPowerZones,
  };
}

/**
One entry of the `groups/v2` stream. A group is known by the metrics of the pack itself; each of its
members carries only the slim slice the groups page reads, which is why the members' statistics are
looked up one by one instead of being assembled in full.

Draft is carried the same way: every member's `state.draft` is its own estimate from `draftOf` (the
rider's `stats.draft.current`, 0 for a rider without statistics) and the group's `draft` is the MEAN
of its members' drafts, 0 for an empty group. `relations.ts` keeps its `group.draft` as plain packet
arithmetic (always 0 there) and is deliberately not consulted for draft, since that file stays free
of statistics.
*/
export function groupRecord(
  group: RiderGroup,
  statsOf: (id: number) => StatsSnapshot | undefined,
  athleteOf?: (id: number) => WidgetAthleteInfo | undefined,
): WidgetGroupRecord {
  const draftOf = (id: number): number => statsOf(id)?.draft.current ?? 0;
  const drafts = group.members.map((member) => draftOf(member.id));

  return {
    watching: group.watching,
    id: group.id,
    athletes: group.members.map((member, index) => {
      const entry = {
        athleteId: member.id,
        watching: member.self,
        eventSubgroupId: null,
        gap: member.gap,
        gapDistance: member.gapDistance,
        // The member's own estimated watts saved in the slipstream, from its statistics.
        state: { power: member.power, heartrate: member.heartrate, speed: member.speed, draft: drafts[index] ?? 0 },
        stats: { power: { smooth: statsOf(member.id)?.power.smooth ?? [] } },
      };
      // Sauce's group members are whole athlete records; mods (DosenHuhn groups) read `athlete.team`.
      const athlete = athleteOf?.(member.id);

      return athlete === undefined ? entry : { ...entry, athlete };
    }),
    power: group.power,
    speed: group.speed,
    heartrate: group.heartrate,
    // The group draft is the mean of the members' estimated draft.
    draft: mean(drafts),
    gap: group.gap,
    innerGap: group.innerGap,
  };
}

/**
The two shapes the same metric comes in on the wire. Sauce sends the smoothed and peak series as
objects keyed by the period in seconds for every event and record whose name carries no `/v2` suffix,
and as arrays of `{ period, avg }` points for the ones that do. The v1 shape is what the older widget
pages read directly (`stats.power.smooth[5]`, `stats.power.peaks[300].avg`), so it is what they have
to be handed.
*/
export interface LegacyMetric {
  avg: number;

  max: number;

  smooth: Record<number, number>;

  peaks: Record<number, { avg?: number }>;
}

/** The `stats` sub-object of a v1 record: the same metrics, in the keyed shape. */
export interface LegacyStats {
  activeTime: number;

  elapsedTime: number;

  power: LegacyMetric & {
    np: number;
    tss: number;
    max: number;
    timeInZones: WidgetRiderRecord['stats']['power']['timeInZones'];
  };

  np: WidgetRiderRecord['stats']['np'];
  speed: LegacyMetric;

  hr: LegacyMetric;

  cadence: { avg: number; max: number };
  draft: LegacyMetric & { kj: number };
}

/** One entry of the v1 `nearby` stream: the v2 record with its statistics keyed by period. */
export type LegacyNearbyRecord = Omit<WidgetRiderRecord, 'stats'> & { stats: LegacyStats };

/** The points of one series as the keys the v1 pages index them by. */
const byPeriod = (points: ReadonlyArray<PeriodAverage>): Record<number, number> =>
  Object.fromEntries(points.map((point) => [point.period, point.avg]));

/**
The peaks of one metric as the v1 pages want them: an entry for every period in `peakPeriods`, since
`peaks[300].avg` is read unconditionally. A period that has no data yet gets an empty object, which
leaves `avg` missing and lets the page print a dash.
*/
const peaksByPeriod = (points: ReadonlyArray<PeriodAverage>): Record<number, { avg?: number }> => {
  const keyed: Record<number, { avg?: number }> = Object.fromEntries(peakPeriods.map((period) => [period, {}]));

  for (const point of points) {
    keyed[point.period] = { avg: point.avg };
  }

  return keyed;
};

/** The metric of the v2 snapshot as the metric of a v1 record. */
const legacyMetric = (metric: WidgetStatsMetric): LegacyMetric => ({
  avg: metric.avg,
  max: metric.max,
  smooth: byPeriod(metric.smooth),
  peaks: peaksByPeriod(metric.peaks),
});

/**
The v1 form of a record: everything as it was assembled, with `stats` converted from the period arrays
to the period-keyed objects. The record handed over is left untouched.
*/
export function legacyRecord(record: WidgetRiderRecord): LegacyNearbyRecord {
  return {
    ...record,
    stats: {
      activeTime: record.stats.activeTime,
      elapsedTime: record.stats.elapsedTime,
      power: {
        ...legacyMetric(record.stats.power),
        np: record.stats.power.np,
        tss: record.stats.power.tss,
        max: record.stats.power.max,
        timeInZones: record.stats.power.timeInZones,
      },
      np: record.stats.np,
      speed: legacyMetric(record.stats.speed),
      hr: legacyMetric(record.stats.hr),
      cadence: { avg: record.stats.cadence.avg, max: record.stats.cadence.max },
      draft: { ...legacyMetric(record.stats.draft), kj: record.stats.draft.kj },
    },
  };
}

export { riderPoint } from '#src/world/state';
