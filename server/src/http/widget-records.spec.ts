import { widgetAthleteInfoSchema, widgetGroupRecordSchema, widgetNearbyRecordSchema } from '#src/dtos/widget-api.dto';
import {
  athleteInfo,
  athleteState,
  botFtpWattsPerKg,
  groupRecord,
  headingDegrees,
  lapSummary,
  legacyRecord,
  nearbyRecord,
  riderPoint,
  widgetStats,
} from '#src/http/widget-records';
import { PlayerProfileSchema, Sport } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { BotProfiles } from '#src/world/bot-profiles';
import { peakPeriods, RiderStats } from '#src/world/live-stats';
import type { StatsSample, StatsSnapshot } from '#src/world/live-stats';
import type { NearbyEntry, RiderGroup } from '#src/world/relations';
import { create } from '@bufbuild/protobuf';
import { Schema } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

const start = 1_000_000;

/** The fields a test packet changes; everything else stays at the protobuf default. */
type Values = Partial<
  Pick<
    PlayerState,
    | 'id'
    | 'distance'
    | 'roadTime'
    | 'laps'
    | 'speed'
    | 'heartrate'
    | 'cadenceUHz'
    | 'power'
    | 'time'
    | 'f19'
    | 'aux3'
    | 'climbing'
    | 'progress'
    | 'x'
    | 'yAltitude'
    | 'z'
    | 'sport'
    | 'route'
    | 'heading'
  >
>;

/** course 6, road 123, travelling the road forwards, riding 36 km/h at 200 W. */
const packet = (fields: Values = {}): PlayerState =>
  create(PlayerStateSchema, {
    id: 7n,
    distance: 12_345,
    roadTime: 20_000,
    laps: 2,
    speed: 36_000_000,
    heartrate: 140,
    power: 200,
    time: 60,
    f19: (6 << 16) | 4,
    aux3: 123 << 8,
    x: 10,
    yAltitude: 4200,
    z: 30,
    sport: Sport.CYCLING,
    route: 0,
    ...fields,
  });

const identity = create(PlayerProfileSchema, {
  firstName: 'John',
  lastName: 'Smith',
  isMale: true,
  weightInGrams: 72_500,
  ftp: 250,
});

/** The watched rider itself: the entry `nearby` always carries for it. */
const watched: NearbyEntry = {
  id: 7,
  self: true,
  gap: 0,
  gapDistance: 0,
  isGapEst: false,
  power: 200,
  speed: 36,
  heartrate: 140,
};

const companion: NearbyEntry = {
  id: 9,
  self: false,
  gap: -4.5,
  gapDistance: -45,
  isGapEst: true,
  power: 190,
  speed: 34,
  heartrate: 132,
};

/** One second of riding at whole second `second`, with missing metrics left at zero. */
const sampleAt = (second: number, values: Partial<Omit<StatsSample, 'time'>> = {}): StatsSample => ({
  time: start + second * 1000,
  power: 0,
  heartrate: 0,
  speed: 0,
  cadence: 0,
  ...values,
});

/** A minute of identical seconds of riding, enough for the 5, 15 and 60 second windows to have filled. */
const ride = (stats: RiderStats, values: Partial<Omit<StatsSample, 'time'>>) => {
  for (let second = 0; second < 60; second += 1) {
    stats.push(sampleAt(second, values));
  }
};

const group: RiderGroup = {
  id: 7,
  watching: true,
  members: [watched, companion],
  gap: 0,
  innerGap: 1.5,
  isGapEst: true,
  power: 210,
  speed: 35.5,
  heartrate: 138,
  draft: 12,
};

const filledStats = (): StatsSnapshot => {
  const stats = new RiderStats();

  ride(stats, { power: 200, heartrate: 140, speed: 30, cadence: 90 });

  return stats.snapshot(250);
};

await test('a nearby record built from real statistics is a valid Sauce nearby record', { timeout: 10_000 }, () => {
  const stats = filledStats();
  const record = nearbyRecord(watched, packet({ cadenceUHz: 1_500_000 }), stats, identity);

  assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));

  assert.equal(record.athleteId, 7);
  assert.equal(record.watching, true);
  // The top-level fields the Analysis page reads: the course of the state and the start of the ride.
  assert.equal(record.courseId, 6);
  assert.equal(record.courseId, record.state.courseId);
  assert.ok(Number.isFinite(record.created) && record.created > 0);
  // The age the Geo/Map page reads to decide the rider is in game: the view only hands fresh states,
  // so the builder stays free of the clock and says "just seen".
  assert.equal(record.age, 0);
  assert.ok(Number.isFinite(record.age));
  assert.equal(record.stats.power.avg, 200);
  assert.equal(record.stats.power.max, 200);
  assert.equal(record.stats.hr.max, 140);
  assert.equal(record.stats.speed.max, 30);
  assert.equal(record.stats.cadence.avg, 90);
  assert.equal(record.stats.cadence.max, 90);
  assert.equal(record.state.cadence, 90);
  assert.deepEqual(
    record.stats.power.smooth.map((point) => point.period),
    [5, 15, 60],
  );
  assert.equal(record.lap.power.max, 200);
  assert.deepEqual(record.lap.cadence, { avg: 90, max: 90 });
  assert.equal(record.lap.activeTime, 60);
  assert.equal('activeTime' in record.lastLap, false);
});

await test(
  'a record built at a known FTP carries the W balance of the model and the capacity it was computed with',
  { timeout: 10_000 },
  () => {
    // Sixty seconds at 310 W against a 250 W FTP: the balance drains by exactly the 60 W surplus.
    const stats = new RiderStats();

    ride(stats, { power: 310 });

    const record = nearbyRecord(watched, packet(), stats.snapshot(250), identity);

    assert.equal(record.wBal, 20_000 - 60 * 60);
    assert.equal(record.athlete.wPrime, 20_000);
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
  },
);

await test('a record built at an unknown FTP carries no W balance and a capacity of zero', { timeout: 10_000 }, () => {
  // What the privacy rule hands another rider: the same statistics taken at FTP 0.
  const stats = new RiderStats();

  ride(stats, { power: 310 });

  const atZero = stats.snapshot(0);
  const record = nearbyRecord(watched, packet(), atZero, identity, 0);

  assert.equal(record.wBal, null);
  assert.equal(record.athlete.wPrime, 0);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
});

await test('a nearby record without statistics is still a valid Sauce nearby record', { timeout: 10_000 }, () => {
  const record = nearbyRecord(companion, packet({ sport: Sport.RUNNING }), undefined, identity, 220);

  assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));

  assert.equal(record.watching, false);
  // A rider without statistics still answers the two top-level fields: the course and a created of 0.
  assert.equal(record.courseId, record.state.courseId);
  assert.equal(record.created, 0);
  assert.equal(record.isGapEst, true);
  assert.equal(record.gap, -4.5);
  assert.equal(record.gapDistance, -45);
  assert.deepEqual(record.stats.power.smooth, []);
  assert.deepEqual(record.stats.power.peaks, []);
  assert.equal(record.stats.activeTime, 0);
  assert.equal(record.stats.elapsedTime, 0);
  assert.deepEqual(record.stats.cadence, { avg: 0, max: 0 });
  assert.equal(record.state.cadence, 0);
  assert.equal(record.state.kj, 0);
  assert.equal(record.athlete.ftp, 250);
  assert.equal(record.state.sport, 'running');
});

/** The `smooth` object of a v1 metric: period keys, plain numbers, and nothing of an array. */
const assertSmooth = (smooth: Readonly<Record<number, number>>, periods: Array<number>) => {
  assert.equal(Array.isArray(smooth), false);
  assert.deepEqual(Object.keys(smooth).toSorted(), periods.map(String).toSorted());

  for (const period of periods) {
    assert.equal(typeof smooth[period], 'number');
  }
};

/** The `peaks` object of a v1 metric: an entry for every peak period, `avg` only where there is data. */
const assertPeaks = (peaks: Record<number, { avg?: number }>, withData: Array<number>) => {
  assert.equal(Array.isArray(peaks), false);
  assert.deepEqual(Object.keys(peaks).toSorted(), [...peakPeriods].map(String).toSorted());

  for (const period of peakPeriods) {
    assert.equal(typeof peaks[period], 'object');

    if (withData.includes(period)) {
      assert.equal(typeof peaks[period]?.avg, 'number');
    } else {
      assert.equal('avg' in (peaks[period] ?? {}), false);
    }
  }
};

await test(
  'a legacy record keys the statistics by period, the way the pages without /v2 read them',
  { timeout: 10_000 },
  () => {
    const stats = filledStats();
    const record = nearbyRecord(watched, packet(), stats, identity);
    const copy = structuredClone(record);
    const legacy = legacyRecord(record);

    // The 60 seconds of riding filled the 5, 15 and 60 second windows, and no window past that.
    assertSmooth(legacy.stats.power.smooth, [5, 15, 60]);
    assert.equal(legacy.stats.power.smooth[5], 200);
    assert.equal(legacy.stats.power.smooth[15], 200);
    assert.equal(legacy.stats.power.smooth[60], 200);
    assert.equal(300 in legacy.stats.power.smooth, false);
    assert.equal(legacy.stats.hr.smooth[60], 140);
    assert.equal(legacy.stats.speed.smooth[15], 30);

    // `peaks[300].avg` is read unconditionally, so every peak period has to be there.
    assertPeaks(legacy.stats.power.peaks, [5, 15, 60]);
    assert.equal(legacy.stats.power.peaks[300]?.avg, undefined);
    assert.equal(legacy.stats.power.peaks[5]?.avg, 200);
    assertPeaks(legacy.stats.hr.peaks, [5, 15, 60]);
    assertPeaks(legacy.stats.speed.peaks, [5, 15, 60]);

    // 60 seconds of riding with no draft fed: its windows are there and zero, exactly like speed's.
    assertSmooth(legacy.stats.draft.smooth, [5, 15, 60]);
    assert.equal(legacy.stats.draft.smooth[5], 0);
    assert.equal(legacy.stats.draft.smooth[60], 0);
    assert.equal(300 in legacy.stats.draft.smooth, false);
    assertPeaks(legacy.stats.draft.peaks, [5, 15, 60]);
    assert.equal(legacy.stats.draft.peaks[5]?.avg, 0);
    assert.equal(legacy.stats.draft.peaks[300]?.avg, undefined);
    assert.equal(legacy.stats.draft.avg, 0);
    assert.equal(legacy.stats.draft.max, 0);

    // Everything but `stats` is handed over as it was.
    assert.equal(legacy.stats.power.avg, record.stats.power.avg);
    assert.equal(legacy.stats.power.np, record.stats.power.np);
    assert.equal(legacy.stats.power.tss, record.stats.power.tss);
    assert.equal(legacy.stats.power.max, record.stats.power.max);
    assert.equal(legacy.stats.draft.kj, record.stats.draft.kj);
    assert.equal(legacy.stats.hr.avg, record.stats.hr.avg);
    assert.deepEqual({ ...legacy, stats: record.stats }, record);
    assert.equal(legacy.athlete.sanitizedFullname, record.athlete.sanitizedFullname);
    assert.equal(legacy.state.kj, record.state.kj);
    assert.equal(legacy.gap, record.gap);
    assert.deepEqual(legacy.lap, record.lap);

    // The record the view holds is left exactly as the v2 stream sends it.
    assert.deepEqual(record, copy);
    assert.deepEqual(
      record.stats.power.peaks.map((point) => point.period),
      [5, 15, 60],
    );
  },
);

await test(
  'a legacy record of a rider without statistics still has an object for every peak period',
  { timeout: 10_000 },
  () => {
    const legacy = legacyRecord(nearbyRecord(companion, packet(), undefined, identity, 220));

    assertSmooth(legacy.stats.power.smooth, []);
    assertSmooth(legacy.stats.draft.smooth, []);
    assertPeaks(legacy.stats.power.peaks, []);
    assertPeaks(legacy.stats.draft.peaks, []);
    assert.equal(legacy.stats.power.peaks[300]?.avg, undefined);
    assert.equal(Object.keys(legacy.stats.power.peaks[300] ?? {}).length, 0);
    assert.equal(legacy.stats.power.avg, 0);
    assert.equal(legacy.stats.draft.kj, 0);
  },
);

await test('a group record is a valid Sauce group record', { timeout: 10_000 }, () => {
  const tracked = new Map<number, StatsSnapshot>([[7, filledStats()]]);
  const untracked = new Map<number, StatsSnapshot>();

  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(widgetGroupRecordSchema)(groupRecord(group, (id) => tracked.get(id))),
  );
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(widgetGroupRecordSchema)(groupRecord(group, (id) => untracked.get(id))),
  );
});

await test('a rider point converts the packet units and reads course, road and direction', { timeout: 10_000 }, () => {
  const point = riderPoint(packet({ speed: 36_000_000 }));

  assert.equal(point.id, 7);
  assert.equal(point.speed, 36);
  assert.equal(point.course, 6);
  assert.equal(point.road, 123);
  assert.equal(point.forward, true);
  assert.equal(point.roadTime, 20_000);
  assert.equal(point.power, 200);
  assert.equal(point.heartrate, 140);
  assert.equal(point.y, 4200);

  const backward = riderPoint(packet({ f19: 6 << 16, aux3: 7 << 8 }));

  assert.equal(backward.course, 6);
  assert.equal(backward.road, 7);
  assert.equal(backward.forward, false);
});

await test('an athlete keeps a printable name and the profile numbers', { timeout: 10_000 }, () => {
  const athlete = athleteInfo(7, identity);

  assert.equal(athlete.id, 7);
  assert.equal(athlete.type, 'NORMAL');
  assert.equal(athlete.sanitizedFullname, 'John Smith');
  assert.equal(athlete.fLast, 'J.Smith');
  assert.equal(athlete.initials, 'JS');
  assert.equal(athlete.gender, 'male');
  assert.equal(athlete.weight, 72.5);
  assert.equal(athlete.ftp, 250);
  assert.equal(athlete.age, null);
  assert.equal(athlete.height, null);
  assert.equal(athlete.racingScore, null);
  assert.equal(athlete.racingCategory, null);
  assert.equal(athlete.muted, false);
  assert.equal(athlete.follower, false);
  assert.equal(athlete.followRequest, false);
  assert.equal(athlete.externalProfile, null);
});

await test('the athlete country code is the numeric profile code, 0 becoming null', { timeout: 10_000 }, () => {
  const polish = athleteInfo(
    7,
    create(PlayerProfileSchema, { id: 7n, firstName: 'John', lastName: 'Smith', countryCode: 616 }),
  );
  const none = athleteInfo(
    7,
    create(PlayerProfileSchema, { id: 7n, firstName: 'John', lastName: 'Smith', countryCode: 0 }),
  );

  assert.equal(polish.countryCode, 616);
  assert.equal(none.countryCode, null);
  assert.equal(athleteInfo(7, identity).countryCode, null);
});

await test('the viewer flags come from the relation handed over', { timeout: 10_000 }, () => {
  const related = athleteInfo(7, identity, 0, undefined, { following: true, marked: true, muted: false });

  assert.equal(related.following, true);
  assert.equal(related.marked, true);
  assert.equal(related.muted, false);

  const plain = athleteInfo(7, identity);

  assert.equal(plain.following, false);
  assert.equal(plain.marked, false);
  assert.equal(plain.muted, false);
});

await test(
  'the athlete equipment resolves the frame name, leaves an unknown frame nameless and is absent when nothing is ridden',
  {
    timeout: 10_000,
  },
  () => {
    const frames = new Map<number, string>([[2_454_550, 'Zwift One']]);

    const equipped = athleteInfo(
      7,
      create(PlayerProfileSchema, {
        id: 7n,
        firstName: 'John',
        lastName: 'Smith',
        bikeFrame: 2_454_550,
        bikeWheelFront: 10,
        bikeWheelRear: 11,
        runShoesType: 3,
      }),
      0,
      undefined,
      undefined,
      frames,
    );

    assert.deepEqual(equipped.equipment, {
      cycling: {
        frame: { id: 2_454_550, name: 'Zwift One' },
        wheelFront: { id: 10, name: null },
        wheelRear: { id: 11, name: null },
      },
      running: { shoes: { id: 3, name: null } },
    });
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetAthleteInfoSchema)(equipped));

    const unknownFrame = athleteInfo(
      7,
      create(PlayerProfileSchema, { id: 7n, firstName: 'John', lastName: 'Smith', bikeFrame: 999_999 }),
      0,
      undefined,
      undefined,
      frames,
    );

    assert.deepEqual(unknownFrame.equipment, {
      cycling: {
        frame: { id: 999_999, name: null },
        wheelFront: { id: 0, name: null },
        wheelRear: { id: 0, name: null },
      },
    });
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetAthleteInfoSchema)(unknownFrame));

    // A profile that rides nothing carries no equipment key at all, and neither does a call that was
    // handed no frame names: whole-object comparisons of such athletes stay unchanged.
    const none = athleteInfo(7, identity, 0, undefined, undefined, frames);

    assert.equal('equipment' in none, false);
    assert.equal('equipment' in athleteInfo(7, identity), false);

    // The record of a nearby rider threads the frame names through to its athlete.
    const record = nearbyRecord(
      watched,
      packet(),
      undefined,
      create(PlayerProfileSchema, { id: 7n, firstName: 'John', lastName: 'Smith', bikeFrame: 2_454_550 }),
      undefined,
      undefined,
      undefined,
      frames,
    );

    assert.deepEqual(record.athlete.equipment, {
      cycling: {
        frame: { id: 2_454_550, name: 'Zwift One' },
        wheelFront: { id: 0, name: null },
        wheelRear: { id: 0, name: null },
      },
    });
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
  },
);

await test('a bot athlete links to its ProCyclingStats page instead of ZwiftPower', { timeout: 10_000 }, () => {
  const bot = athleteInfo(
    8_500_127,
    create(PlayerProfileSchema, { id: 8_500_127n, firstName: 'Benoît', lastName: 'Cosnefroy (UAD)' }),
  );

  assert.deepEqual(bot.externalProfile, {
    name: 'ProCyclingStats',
    url: 'https://www.procyclingstats.com/rider/benoit-cosnefroy',
  });
});

await test(
  'a bot athlete carries the facts of the bot catalogue and nothing else does',
  {
    timeout: 10_000,
  },
  () => {
    const catalogue = BotProfiles.parse(
      JSON.stringify({
        teams: { UAD: { name: 'UAE Team Emirates', country: 'AE', website: 'https://uae.example' } },
        riders: [
          {
            name: 'Jan Kos',
            country: 'SI',
            team: 'UAD',
            pcs: 'x-y',
            born: '1998-09-21',
            birthplace: 'Klanec',
            bio: 'Short bio.',
            photo: {
              url: 'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg',
              author: 'A',
              license: 'CC BY 4.0',
              source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
            },
            wikidata: 'Q1',
          },
        ],
      }),
    );

    const withFacts = athleteInfo(
      8_500_127,
      create(PlayerProfileSchema, { id: 8_500_127n, firstName: 'Jan', lastName: 'Kos' }),
      0,
      catalogue,
    );

    assert.deepEqual(withFacts.bot, {
      countryName: 'Slovenia',
      teamName: 'UAE Team Emirates',
      teamWebsite: 'https://uae.example',
      born: '1998-09-21',
      birthplace: 'Klanec',
      bio: 'Short bio.',
      wikidata: 'Q1',
      photo: { author: 'A', license: 'CC BY 4.0', source: 'https://commons.wikimedia.org/wiki/File:X.jpg' },
    });
    assert.equal(withFacts.avatar, '/api/bot-photo/8500127');
    assert.equal(withFacts.countryCode, 705);

    const realRider = athleteInfo(
      7,
      create(PlayerProfileSchema, { id: 7n, firstName: 'Jan', lastName: 'Kos' }),
      0,
      catalogue,
    );

    assert.equal(realRider.bot, null);

    const unknownBot = athleteInfo(
      8_500_128,
      create(PlayerProfileSchema, { id: 8_500_128n, firstName: 'Unknown', lastName: 'Bot' }),
      0,
      catalogue,
    );

    assert.equal(unknownBot.bot, null);
    assert.equal(unknownBot.avatar, '');

    const withoutCatalogue = athleteInfo(
      8_500_127,
      create(PlayerProfileSchema, { id: 8_500_127n, firstName: 'Jan', lastName: 'Kos' }),
    );

    assert.equal(withoutCatalogue.bot, null);
  },
);

await test(
  'an athlete name is sanitized, and a missing first name leaves only the last one',
  {
    timeout: 10_000,
  },
  () => {
    const tricky = athleteInfo(
      1,
      create(PlayerProfileSchema, { firstName: 'J<b>o', lastName: "O'Brien&", isMale: false, weightInGrams: 60_000 }),
    );

    assert.equal(tricky.sanitizedFullname, 'Jbo OBrien');
    assert.equal(tricky.fLast, 'J.OBrien');
    assert.equal(tricky.initials, 'JO');
    assert.equal(tricky.gender, 'female');

    const lastOnly = athleteInfo(1, create(PlayerProfileSchema, { firstName: ' '.repeat(3), lastName: 'Smith' }));

    assert.equal(lastOnly.sanitizedFullname, 'Smith');
    assert.equal(lastOnly.fLast, 'Smith');
    assert.equal(lastOnly.initials, 'S');
  },
);

await test('the athlete state mirrors the packet and reverses the travel direction', { timeout: 10_000 }, () => {
  const forward = athleteState(packet(), filledStats());

  assert.equal(forward.sport, 'cycling');
  assert.equal(forward.routeId, null);
  assert.equal(forward.courseId, 6);
  assert.equal(forward.roadId, 123);
  assert.equal(forward.reverse, false);
  assert.equal(forward.speed, 36);
  assert.equal(forward.altitude, 42);
  // The Geo/Map position: `x` is the packet's x, `y` the packet's z (the game's other horizontal
  // axis) and `z` the altitude in metres, the same value as `altitude`.
  assert.equal(forward.x, 10);
  assert.equal(forward.y, 30);
  assert.equal(forward.z, 42);
  assert.equal(forward.roadCompletion, 15_000);
  assert.equal(forward.kj, 12);
  assert.equal(forward.powerMeter, 0);
  // The grade is no longer a hardcoded zero: it comes straight from the statistics.
  const gradedStats = filledStats();

  gradedStats.grade = 0.0375;

  assert.equal(athleteState(packet(), gradedStats).grade, 0.0375);

  const onRoute = athleteState(packet({ route: 42, roadTime: 1000, f19: (6 << 16) | 1 }), filledStats());

  assert.equal(onRoute.routeId, 42);
  assert.equal(onRoute.reverse, true);
  // Reversed, the position is counted from the other end of the road (Sauce: 1_005_000 - roadTime).
  assert.equal(onRoute.roadCompletion, 1_004_000);
  assert.equal(onRoute.powerMeter, 1);

  assert.equal(athleteState(packet({ sport: Sport.RUNNING }), filledStats()).sport, 'running');

  // A packet with non-finite position values must not poison the page: they become 0.
  const broken = athleteState(packet({ x: notANumber, z: Infinity, yAltitude: notANumber }), filledStats());

  assert.equal(broken.x, 0);
  assert.equal(broken.y, 0);
  assert.equal(broken.z, 0);
  assert.equal(broken.altitude, 0);
});

await test('the heading is the direction of travel in degrees in [0, 360)', { timeout: 10_000 }, () => {
  // The packet carries radians times 1e6; the page wants degrees offset by 180 (see `headingDegrees`).
  assert.equal(headingDegrees(0n), 180);
  assert.equal(headingDegrees(Math.PI * 1e6), 0);
  assert.equal(headingDegrees((Math.PI / 2) * 1e6), 270);
  assert.ok(Math.abs(headingDegrees(BigInt(Math.round(Math.PI * 1e6)))) < 1e-4);
  assert.ok(Math.abs(headingDegrees(BigInt(Math.round((Math.PI / 2) * 1e6))) - 270) < 1e-4);
  // A raw value outside [0, 2π) still lands inside [0, 360).
  assert.ok(headingDegrees(-3_000_000n) >= 0);
  assert.ok(headingDegrees(-3_000_000n) < 360);
  assert.ok(headingDegrees(BigInt(Math.round(4 * Math.PI * 1e6))) < 360);
  // A packet without the field (or a broken one) must not hand NaN to the page.
  assert.equal(headingDegrees(notANumber), 0);
  assert.equal(headingDegrees(Infinity), 0);

  const eastbound = athleteState(packet({ heading: BigInt(Math.round(Math.PI * 1e6)) }), filledStats()).heading;

  assert.equal(athleteState(packet({ heading: 0n }), filledStats()).heading, 180);
  assert.ok(eastbound >= 0 && eastbound < 360);
  assert.ok(eastbound < 1e-4 || 360 - eastbound < 1e-4);
  // SAFETY: a decoded packet never holds NaN, but the heading arithmetic must not pass one on either.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, quality/no-chained-type-assertions
  const broken = notANumber as unknown as bigint;

  assert.equal(athleteState(packet({ heading: broken }), filledStats()).heading, 0);
});

await test('the sauce stats carry every metric with its windows', { timeout: 10_000 }, () => {
  const stats = widgetStats(filledStats());

  assert.equal(stats.power.avg, 200);
  assert.equal(stats.power.max, 200);
  assert.equal(stats.hr.avg, 140);
  assert.equal(stats.hr.max, 140);
  assert.equal(stats.speed.avg, 30);
  assert.equal(stats.speed.max, 30);
  assert.deepEqual(stats.cadence, { avg: 90, max: 90 });
  assert.equal(stats.activeTime, 60);
  assert.equal(stats.elapsedTime, 60);

  // No draft was ever fed, yet the windows of a 60 second ride are there, zero-valued like speed's.
  assert.equal(stats.draft.avg, 0);
  assert.equal(stats.draft.max, 0);
  assert.equal(stats.draft.kj, 0);
  assert.deepEqual(
    stats.draft.smooth.map((point) => point.period),
    [5, 15, 60],
  );
  assert.deepEqual(
    stats.draft.peaks.map((point) => point.period),
    [5, 15, 60],
  );
  assert.deepEqual(
    stats.draft.smooth.map((point) => point.avg),
    [0, 0, 0],
  );
  assert.deepEqual(
    stats.draft.peaks.map((point) => point.avg),
    [0, 0, 0],
  );
});

/** A rider who sat in a slipstream a full minute: 30 W of estimated draft the whole time. */
const draftedStats = (): StatsSnapshot => {
  const stats = new RiderStats();

  ride(stats, { power: 250, heartrate: 140, speed: 30, cadence: 90, draft: 30 });

  return stats.snapshot(250);
};

await test(
  'a drafted rider is answered with the estimate: the state, the v2 and v1 windows, the energy and the lap',
  { timeout: 10_000 },
  () => {
    const stats = draftedStats();
    const record = nearbyRecord(watched, packet(), stats, identity);
    const legacy = legacyRecord(record);

    assert.equal(record.state.draft, 30);

    // The v2 arrays carry the filled windows like every other metric.
    assert.equal(record.stats.draft.avg, 30);
    assert.equal(record.stats.draft.max, 30);
    assert.ok(Math.abs(record.stats.draft.kj - 1.8) <= 1e-9);
    assert.deepEqual(
      record.stats.draft.smooth.map((point) => [point.period, point.avg]),
      [
        [5, 30],
        [15, 30],
        [60, 30],
      ],
    );

    // The v1 legacy object shape the pages without /v2 index by period.
    assertSmooth(legacy.stats.draft.smooth, [5, 15, 60]);
    assert.equal(legacy.stats.draft.smooth[5], 30);
    assert.equal(legacy.stats.draft.smooth[60], 30);
    assertPeaks(legacy.stats.draft.peaks, [5, 15, 60]);
    assert.equal(legacy.stats.draft.peaks[5]?.avg, 30);
    assert.equal(legacy.stats.draft.kj, record.stats.draft.kj);

    // The lap averages the same estimate.
    assert.deepEqual(record.lap.draft, { avg: 30, max: 30 });
    assert.deepEqual(record.lastLap.draft, { avg: 0, max: 0 });
  },
);

await test('a record built from the empty snapshot has every draft number at zero', { timeout: 10_000 }, () => {
  const record = nearbyRecord(watched, packet(), undefined, identity, 220);
  const legacy = legacyRecord(record);

  assert.equal(record.state.draft, 0);
  assert.deepEqual(record.stats.draft, { avg: 0, max: 0, smooth: [], peaks: [], kj: 0 });
  assert.equal(record.lap.draft.avg, 0);
  assert.equal(record.lap.draft.max, 0);
  assert.equal(legacy.stats.draft.kj, 0);
  assertSmooth(legacy.stats.draft.smooth, []);
  assertPeaks(legacy.stats.draft.peaks, []);
});

await test('only the current lap carries activeTime', { timeout: 10_000 }, () => {
  const lap = filledStats().lap;
  const withTime = lapSummary(lap, true);
  const withoutTime = lapSummary(lap, false);

  assert.equal(withTime.activeTime, 60);
  assert.equal('activeTime' in withTime, true);
  assert.equal('activeTime' in withoutTime, false);
  assert.equal(withoutTime.power.avg, 200);
});

/** `count` seconds of riding at the given draft, returned as the snapshot the records are built from. */
const drafted = (draft: number): StatsSnapshot => {
  const stats = new RiderStats();

  ride(stats, { power: 200, draft });

  return stats.snapshot(250);
};

await test('a group record copies the pack numbers and keeps its members in order', { timeout: 10_000 }, () => {
  const stats = filledStats();
  const record = groupRecord(group, (id) => (id === 7 ? stats : undefined));

  assert.equal(record.watching, true);
  assert.equal(record.id, 7);
  assert.equal(record.gap, 0);
  assert.equal(record.innerGap, 1.5);
  assert.equal(record.power, 210);
  assert.equal(record.speed, 35.5);
  assert.equal(record.heartrate, 138);
  // Neither rider of this pack has a draft in its statistics, so the drafts stay zero.
  assert.equal(record.draft, 0);

  assert.deepEqual(
    record.athletes.map((athlete) => athlete.athleteId),
    [7, 9],
  );
  assert.deepEqual(
    record.athletes.map((athlete) => athlete.gap),
    [0, -4.5],
  );
  assert.deepEqual(
    record.athletes.map((athlete) => athlete.stats.power.smooth.length),
    [3, 0],
  );
  assert.deepEqual(record.athletes[1]?.state, { power: 190, heartrate: 132, speed: 34, draft: 0 });
  assert.equal(record.athletes[0]?.watching, true);
  assert.equal(record.athletes[1]?.watching, false);
});

await test(
  'a group carries each member own draft estimate and the mean of them as the group draft',
  { timeout: 10_000 },
  () => {
    const back: NearbyEntry = {
      id: 11,
      self: false,
      gap: 3,
      gapDistance: 30,
      isGapEst: false,
      power: 220,
      speed: 37,
      heartrate: 145,
    };

    const pack: RiderGroup = { ...group, members: [watched, companion, back] };
    const estimates = new Map<number, StatsSnapshot>([
      [9, drafted(30)],
      [11, drafted(60)],
    ]);

    const record = groupRecord(pack, (id) => estimates.get(id));

    // 0 (no statistics at all), 30 and 60 W: the pack shows the 30 W mean.
    assert.equal(record.draft, 30);
    assert.deepEqual(
      record.athletes.map((athlete) => athlete.state.draft),
      [0, 30, 60],
    );
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetGroupRecordSchema)(record));
  },
);

await test('a group of riders without statistics has every draft at zero', { timeout: 10_000 }, () => {
  const record = groupRecord(group, () => {});

  assert.equal(record.draft, 0);
  assert.deepEqual(
    record.athletes.map((athlete) => athlete.state.draft),
    [0, 0],
  );
});

await test(
  'the athlete level is the achievement level of the profile divided by a hundred',
  { timeout: 10_000 },
  () => {
    assert.equal(athleteInfo(7, create(PlayerProfileSchema, { achievementLevel: 10_650 })).level, 106);
    assert.equal(athleteInfo(7, identity).level, 0);
    assert.equal(athleteInfo(7, create(PlayerProfileSchema, { achievementLevel: notANumber })).level, 0);
  },
);

await test(
  'the record carries the seconds per power zone at the top level, and nothing without a known ftp',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, { power: 200 });

    // The snapshot of a viewer who may see the FTP knows the zones; taken at FTP 0 it does not.
    const known = nearbyRecord(watched, packet(), stats.snapshot(250), identity);
    const hidden = nearbyRecord(watched, packet(), stats.snapshot(0), identity, 0);

    assert.deepEqual(known.timeInPowerZones, stats.snapshot(250).timeInPowerZones);
    assert.deepEqual(
      known.timeInPowerZones.map((entry) => entry.zone),
      ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'],
    );
    assert.deepEqual(hidden.timeInPowerZones, []);
    assert.deepEqual(nearbyRecord(companion, packet(), undefined, identity, 0).timeInPowerZones, []);
    // A rider we have no statistics for still answers every zone, empty of seconds.
    assert.deepEqual(
      nearbyRecord(companion, packet(), undefined, identity, 220).timeInPowerZones,
      new RiderStats().snapshot(220).timeInPowerZones,
    );
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(known));
    // The v1 form keeps the top level exactly as it was assembled.
    assert.deepEqual(legacyRecord(known).timeInPowerZones, known.timeInPowerZones);
  },
);

await test(
  'a bot rider is shown a pro-level displayed ftp built from its weight, a real rider its own',
  { timeout: 10_000 },
  () => {
    // A bot at 70 kg whose stored FTP is hidden by the privacy rule (0) still gets a plausible FTP.
    const leanBot = create(PlayerProfileSchema, {
      id: 8_500_127n,
      firstName: 'Jan',
      lastName: 'Kos',
      weightInGrams: 70_000,
      ftp: 0,
    });

    assert.equal(athleteInfo(8_500_127, leanBot).ftp, 420);
    assert.equal(botFtpWattsPerKg, 6);

    // A bot profile without a usable weight rides at the assumed 70 kg.
    const weightless = create(PlayerProfileSchema, {
      id: 8_500_127n,
      firstName: 'Jan',
      lastName: 'Kos',
      weightInGrams: 0,
      ftp: 0,
    });
    const broken = create(PlayerProfileSchema, {
      id: 8_500_127n,
      firstName: 'Jan',
      lastName: 'Kos',
      weightInGrams: notANumber,
      ftp: 0,
    });

    assert.equal(athleteInfo(8_500_127, weightless).ftp, 420);
    assert.equal(athleteInfo(8_500_127, broken).ftp, 420);

    // A real rider keeps exactly the FTP it was handed, which the privacy rule has already gated.
    assert.equal(athleteInfo(7, create(PlayerProfileSchema, { firstName: 'John', lastName: 'Smith', ftp: 0 })).ftp, 0);
    assert.equal(athleteInfo(7, identity).ftp, 250);

    // The whole record stays a valid Sauce record for a bot too.
    const botEntry: NearbyEntry = { ...companion, id: 8_500_127 };
    const record = nearbyRecord(botEntry, packet(), undefined, leanBot);

    assert.equal(record.athlete.ftp, 420);
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
  },
);

await test('the athlete state reports the ride ons it was handed, and 0 for anything else', { timeout: 10_000 }, () => {
  assert.equal(athleteState(packet(), filledStats()).rideons, 0);
  assert.equal(athleteState(packet(), filledStats(), 7).rideons, 7);
  assert.equal(athleteState(packet(), filledStats(), -3).rideons, 0);
  assert.equal(athleteState(packet(), filledStats(), notANumber).rideons, 0);
  assert.equal(athleteState(packet(), filledStats(), 3.7).rideons, 3);
});

await test('a nearby record carries the ride ons of its rider', { timeout: 10_000 }, () => {
  assert.equal(nearbyRecord(watched, packet(), filledStats(), identity).state.rideons, 0);
  assert.equal(
    nearbyRecord(watched, packet(), filledStats(), identity, undefined, undefined, undefined, undefined, 0, 12).state
      .rideons,
    12,
  );
});

await test('the state carries the climbed metres, the route progress and the name of the active power-up', () => {
  // aux3: low 4 bits = power-up type 5 (AERO, the index into the names; 15 is none); progress: bits 8..15 = 42 %.
  const state = athleteState(packet({ climbing: 120, aux3: 5, progress: (42 << 8) | 3 }), filledStats());

  assert.equal(state.climbing, 120);
  assert.equal(state.progress, 42 / 255);
  assert.equal(state.activePowerUp, 'AERO');
  assert.equal(state.workoutZone, 3);
  assert.equal(athleteState(packet({ aux3: 0xf }), filledStats()).activePowerUp, null);
  assert.equal(athleteState(packet({ f19: 7 << 24 }), filledStats()).rideons, 7);
});
