import { Schema } from 'effect';

// Wire shapes of the widget API that Sauce for Zwift widget pages and mods read (`nearby`,
// `groups/v2`, `athlete/<id>`). Field names mirror Sauce's own records, not our internal ones.

/** One entry of a metric's `smooth`/`peaks` series, keyed by period in seconds. */
const smoothPointSchema = Schema.Struct({ period: Schema.Finite, avg: Schema.Finite });

/** `state` sub-object of an athlete record: live ride state of the watched/known rider. */
export const widgetAthleteStateSchema = Schema.Struct({
  sport: Schema.String,
  eventSubgroupId: Schema.NullOr(Schema.Finite),
  routeId: Schema.NullOr(Schema.Finite),
  distance: Schema.Finite,
  rideons: Schema.Finite,
  kj: Schema.Finite,
  powerMeter: Schema.Finite,
  grade: Schema.Finite,
  altitude: Schema.Finite,
  // The position the Geo/Map page hands to `ent.setPosition([state.x, state.y])`: `x` is the game's x
  // coordinate and `y` the OTHER horizontal axis (our protocol field `z` of the PlayerState), while
  // `z` is the altitude in metres, the same value as `altitude` above.
  x: Schema.Finite,
  y: Schema.Finite,
  z: Schema.Finite,
  // The direction of travel the Geo/Map page rotates the view with: degrees in [0, 360) (see
  // `headingDegrees` in `http/widget-records` for how the packet's raw heading maps onto it).
  heading: Schema.Finite,
  laps: Schema.Finite,
  eventDistance: Schema.Finite,
  progress: Schema.Finite,
  workoutZone: Schema.NullOr(Schema.Finite),
  roadId: Schema.NullOr(Schema.Finite),
  roadCompletion: Schema.Finite,
  roadTime: Schema.Finite,
  power: Schema.Finite,
  speed: Schema.Finite,
  heartrate: Schema.Finite,
  cadence: Schema.Finite,
  draft: Schema.Finite,
  time: Schema.Finite,
  reverse: Schema.Boolean,
  courseId: Schema.NullOr(Schema.Finite),
  latency: Schema.Finite,
  // The name of the power-up the rider is under (`AERO`, `DRAFTBOOST`, ...), null when none.
  activePowerUp: Schema.NullOr(Schema.String),
  // Metres climbed since the ride started.
  climbing: Schema.Finite,
  // The game's world clock of the packet, in milliseconds.
  worldTime: Schema.Finite,
  routeCheckpointIndex: Schema.Finite,
  // Distance ridden along the route and where one lap of it ends; only for a rider on a known route.
  routeDistance: Schema.optional(Schema.Finite),
  routeEnd: Schema.optional(Schema.Finite),
  routeDecisionIndex: Schema.Finite,
});

/** `stats` metric shape: current average plus smoothed/peak series per period. */
export const widgetStatsMetricSchema = Schema.Struct({
  avg: Schema.Finite,
  max: Schema.Finite,
  smooth: Schema.Array(smoothPointSchema),
  peaks: Schema.Array(smoothPointSchema),
});

/** `stats.power`: adds normalized power and training stress score. */
export const widgetStatsPowerMetricSchema = Schema.Struct({
  ...widgetStatsMetricSchema.fields,
  np: Schema.Finite,
  tss: Schema.Finite,
  // Seconds in each power zone; Sauce also carries it here, DosenHuhn's power distribution reads it.
  timeInZones: Schema.Array(Schema.Struct({ zone: Schema.String, time: Schema.Finite })),
});

/** `stats.draft`: adds the draft energy in kJ. */
export const widgetStatsDraftMetricSchema = Schema.Struct({
  ...widgetStatsMetricSchema.fields,
  kj: Schema.Finite,
});

/** `lap` / `lastLap`: reduced per-metric averages and maxima; `activeTime` is absent on `lastLap`. */
const lapMetric = Schema.Struct({ avg: Schema.Finite, max: Schema.Finite });

export const widgetLapSummarySchema = Schema.Struct({
  power: lapMetric,
  speed: lapMetric,
  hr: lapMetric,
  cadence: lapMetric,
  draft: lapMetric,
  activeTime: Schema.optional(Schema.Finite),
});

/** One entry of an athlete's `equipment` (Zwift 2.4): an id known to the game and, when the server
knows it, its name. */
const equipmentItemSchema = Schema.Struct({ id: Schema.Finite, name: Schema.NullOr(Schema.String) });

/** `athlete.equipment`: what the rider rides and runs with, the Zwift 2.4 addition to athlete objects. */
const equipmentSchema = Schema.Struct({
  cycling: Schema.optional(
    Schema.Struct({ frame: equipmentItemSchema, wheelFront: equipmentItemSchema, wheelRear: equipmentItemSchema }),
  ),
  running: Schema.optional(Schema.Struct({ shoes: equipmentItemSchema })),
});

/** `athlete` sub-object: identity and physiological profile. */
export const widgetAthleteInfoSchema = Schema.Struct({
  id: Schema.Finite,
  firstName: Schema.String,
  lastName: Schema.String,
  sanitizedFullname: Schema.String,
  fLast: Schema.String,
  initials: Schema.String,
  avatar: Schema.String,
  countryCode: Schema.NullOr(Schema.Finite),
  gender: Schema.String,
  type: Schema.String,
  age: Schema.NullOr(Schema.Finite),
  height: Schema.NullOr(Schema.Finite),
  racingScore: Schema.NullOr(Schema.Finite),
  racingCategory: Schema.NullOr(Schema.String),
  team: Schema.NullOr(Schema.String),
  weight: Schema.Finite,
  level: Schema.Finite,
  ftp: Schema.Finite,
  cp: Schema.Finite,
  wPrime: Schema.Finite,
  marked: Schema.Boolean,
  following: Schema.Boolean,
  muted: Schema.Boolean,
  follower: Schema.Boolean,
  followRequest: Schema.Boolean,
  externalProfile: Schema.NullOr(Schema.Struct({ name: Schema.String, url: Schema.String })),
  equipment: Schema.optional(equipmentSchema),
  bot: Schema.NullOr(
    Schema.Struct({
      countryName: Schema.NullOr(Schema.String),
      teamName: Schema.NullOr(Schema.String),
      teamWebsite: Schema.NullOr(Schema.String),
      born: Schema.NullOr(Schema.String),
      birthplace: Schema.NullOr(Schema.String),
      bio: Schema.NullOr(Schema.String),
      wikidata: Schema.NullOr(Schema.String),
      photo: Schema.NullOr(Schema.Struct({ author: Schema.String, license: Schema.String, source: Schema.String })),
    }),
  ),
});

/** One entry of the `nearby` event payload (a rider near the watched rider). */
export const widgetNearbyRecordSchema = Schema.Struct({
  athleteId: Schema.Finite,
  watching: Schema.Boolean,
  eventLeader: Schema.Boolean,
  eventSweeper: Schema.Boolean,
  gap: Schema.Finite,
  gapDistance: Schema.Finite,
  isGapEst: Schema.Boolean,
  remaining: Schema.NullOr(Schema.Finite),
  remainingMetric: Schema.NullOr(Schema.String),
  eventPosition: Schema.NullOr(Schema.Finite),
  lapCount: Schema.Finite,
  wBal: Schema.NullOr(Schema.Finite),
  stats: Schema.Struct({
    activeTime: Schema.Finite,
    elapsedTime: Schema.Finite,
    power: widgetStatsPowerMetricSchema,
    speed: widgetStatsMetricSchema,
    hr: widgetStatsMetricSchema,
    // `getSmoothCompat(x, 'np', period)` of the efficiency factor (hrEF) reads this.
    np: Schema.Struct({ smooth: Schema.Array(smoothPointSchema) }),
    cadence: Schema.Struct({ avg: Schema.Finite, max: Schema.Finite }),
    draft: widgetStatsDraftMetricSchema,
  }),
  lap: widgetLapSummarySchema,
  lastLap: widgetLapSummarySchema,
  athlete: widgetAthleteInfoSchema,
  state: widgetAthleteStateSchema,
  // The course of the rider's state, which the Analysis page hands to `zwiftMap.setCourse`.
  courseId: Schema.Finite,
  // Millisecond epoch of the first sample of the ride, which the page compares between polls.
  created: Schema.Finite,
  // Milliseconds since the rider's last packet; the Geo/Map page reads it to decide whether the
  // rider is in game at all.
  age: Schema.Finite,
  // Seconds in each power zone; empty when the viewer may not use this rider's FTP.
  timeInPowerZones: Schema.Array(Schema.Struct({ zone: Schema.String, time: Schema.Finite })),
});

/** One entry of the `groups/v2` event payload; athletes carry only a slim state/stats slice. */
export const widgetGroupRecordSchema = Schema.Struct({
  watching: Schema.Boolean,
  id: Schema.Finite,
  athletes: Schema.Array(
    Schema.Struct({
      athleteId: Schema.Finite,
      watching: Schema.Boolean,
      eventSubgroupId: Schema.NullOr(Schema.Finite),
      athlete: Schema.optional(widgetAthleteInfoSchema),
      gap: Schema.Finite,
      gapDistance: Schema.Finite,
      state: Schema.Struct({
        power: Schema.Finite,
        heartrate: Schema.Finite,
        speed: Schema.Finite,
        draft: Schema.Finite,
      }),
      stats: Schema.Struct({ power: Schema.Struct({ smooth: Schema.Array(smoothPointSchema) }) }),
    }),
  ),
  power: Schema.Finite,
  speed: Schema.Finite,
  heartrate: Schema.Finite,
  draft: Schema.Finite,
  gap: Schema.Finite,
  innerGap: Schema.Finite,
});

export type WidgetAthleteState = Schema.Schema.Type<typeof widgetAthleteStateSchema>;
export type WidgetStatsMetric = Schema.Schema.Type<typeof widgetStatsMetricSchema>;
export type WidgetStatsPowerMetric = Schema.Schema.Type<typeof widgetStatsPowerMetricSchema>;
export type WidgetStatsDraftMetric = Schema.Schema.Type<typeof widgetStatsDraftMetricSchema>;
export type WidgetLapSummary = Schema.Schema.Type<typeof widgetLapSummarySchema>;
export type WidgetAthleteInfo = Schema.Schema.Type<typeof widgetAthleteInfoSchema>;
export type WidgetNearbyRecord = Schema.Schema.Type<typeof widgetNearbyRecordSchema>;
export type WidgetGroupRecord = Schema.Schema.Type<typeof widgetGroupRecordSchema>;

/** What the viewer marked about another rider: followed, marked or muted. */
export interface OverlayRelation {
  following: boolean;
  marked: boolean;
  muted: boolean;
}

export const noRelation: OverlayRelation = { following: false, marked: false, muted: false };
