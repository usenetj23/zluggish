import { powerZones, zonesRevision } from '#src/world/power-zones';
import type { PowerZone } from '#src/world/power-zones';
import { NormalizedPower, PeakTracker, WindowedNormalizedPower } from '#src/world/rolling';
import { defaultWPrime, WPrimeBalance } from '#src/world/wbal';

/** Rolling averages shown as the ride unfolds, from 5 seconds up to 20 minutes. */
export const smoothPeriods: ReadonlyArray<number> = [5, 15, 60, 300, 1200];

/** Best-average-ever records, from a 5 second sprint up to a full hour. */
export const peakPeriods: ReadonlyArray<number> = [5, 15, 60, 300, 1200, 3600];

/** A gap of this many seconds or less is still riding; a longer one is a pause. */
const maxGap = 6;

export interface StatsSample {
  /** worldTime, in milliseconds. */
  time: number;

  /** watts. */
  power: number;

  /** metres ridden, `state.distance` of the packet; feed it to get a real `grade` in the snapshot. */
  distance?: number;

  /** raw `state.yAltitude` of the packet, in centimetres with the 9000 offset of `world/streams`. */
  yAltitude?: number;

  /** beats per minute. */
  heartrate: number;

  /** km/h. */
  speed: number;

  /** revolutions per minute. */
  cadence: number;

  /** watts saved in the slipstream, an estimate fed by the caller; 0 when absent. */
  draft?: number;
}

/** The average over one period, in the units of the metric it belongs to. */
export interface PeriodAverage {
  period: number;

  avg: number;
}

/** A metric as a current average, the rolling averages and the all time records. */
export interface MetricSnapshot {
  avg: number;

  max: number;

  smooth: Array<PeriodAverage>;

  peaks: Array<PeriodAverage>;
}

export interface PowerSnapshot extends MetricSnapshot {
  np: number;

  tss: number;

  kj: number;

  /** joules of W' left, or null when the viewer may not use this rider's FTP (the privacy rule). */
  wBal: number | null;
}

/**
The draft is an ESTIMATE: the protocol never reports drafting, so the caller feeds the estimated
watts saved in the slipstream with each sample. A caller that feeds nothing leaves every number 0.
*/
export interface DraftSnapshot extends MetricSnapshot {
  /** the draft of the most recent second, 0 before any sample. */
  current: number;

  kj: number;
}

/** The current or the last finished lap; `draft` averages the same estimate as `DraftSnapshot`. */
export interface LapSnapshot {
  power: { avg: number; max: number };

  speed: { avg: number; max: number };

  hr: { avg: number; max: number };

  cadence: { avg: number; max: number };

  draft: { avg: number; max: number };

  activeTime: number;
}

/**
Where one lap of the ride happened, in the same seconds as the `sec` of `push` (game world seconds).
`endSec` is the last second belonging to the lap, or null while the lap is still running.
*/
export interface LapSpan {
  /** the lap number, counting from 1. */
  id: number;

  startSec: number;

  endSec: number | null;
}

/** Seconds spent in one power zone, under the zone name `powerZones` hands out. */
export interface PowerZoneTime {
  zone: string;

  /** seconds. */
  time: number;
}

export interface StatsSnapshot {
  activeTime: number;

  elapsedTime: number;

  power: PowerSnapshot;

  speed: MetricSnapshot;

  hr: MetricSnapshot;

  draft: DraftSnapshot;

  cadence: { avg: number; max: number };

  /**
  Seconds of active riding spent in each power zone, in the zone order of `powerZones`, empty when the
  FTP the snapshot is taken at is not a finite number above zero (the privacy rule, same as `wBal`).
  */
  timeInPowerZones: Array<PowerZoneTime>;

  lap: LapSnapshot;

  lastLap: LapSnapshot;

  /**
  Road grade as a FRACTION (0.05 means 5%), smoothed and clamped to [-0.35, 0.35]; 0 when no climb
  stream sample carried a usable distance and altitude.
  */
  grade: number;

  /** normalized power of the last 5 and 20 minutes, once those windows are full. */
  npSmooth: Array<PeriodAverage>;

  /** the number of the lap that is running now, 1 for a ride that never pressed lap. */
  lapCount: number;

  /** millisecond epoch of the first accepted sample, 0 when there was none. */
  created: number;
}

/** The last road positions remembered for the grade, newest at the end. */
type GradeSample = { distance: number; altitude: number };

/** How many of the last positions the grade looks over; at a per second sample, two minutes. */
const gradeWindow = 120;

/** The climb or descent is measured over at least this many metres... */
const gradeMinSpan = 30;
/** ...and over no more than this many, so a long gentle slope is still felt. */
const gradeMaxSpan = 200;
/** A shorter distance difference than this is noise, not a grade. */
const gradeMinDelta = 10;
/** The steepest grade the climb stream can carry; anything beyond is a packet glitch. */
const gradeMax = 0.35;
/** Exponential smoothing of successive grade readings (new = 0.7 * previous + 0.3 * raw). */
const gradeSmoothing = 0.3;

/**
The road positions of the last `gradeWindow` samples and the grade smoothed out of them. A sample
needs both a finite distance and a finite altitude to enter the buffer. The grade is the altitude
difference over the oldest buffered position at least `gradeMinSpan` (and at most `gradeMaxSpan`)
behind the newest: too short a stretch lets the noisy altitude fake a wall, too long one averages a
single hill away. A distance that went backwards is a ride reset: the buffer is cleared and the last
grade kept. `yAltitude` of the packet carries the 9000 cm offset of `world/streams`; a constant offset
cancels in a difference, so the samples keep whatever offset the caller fed.
*/
class GradeTracker {
  private samples: Array<GradeSample> = [];

  private grade = 0;

  push(distance: number, altitude: number) {
    if (!Number.isFinite(distance) || !Number.isFinite(altitude)) {
      return;
    }

    if (this.samples.length > 0 && distance < (this.samples.at(-1)?.distance ?? 0)) {
      this.samples = [];
    }

    this.samples.push({ distance, altitude });

    if (this.samples.length > gradeWindow) {
      this.samples.shift();
    }

    const raw = this.raw();

    if (raw !== null) {
      this.grade = Math.min(gradeMax, Math.max(-gradeMax, this.grade * (1 - gradeSmoothing) + raw * gradeSmoothing));
    }
  }

  /** The altitude over distance of the widest stretch the window allows, null when none qualifies. */
  private raw(): number | null {
    const newest = this.samples.at(-1);

    if (newest === undefined) {
      return null;
    }

    let oldest: GradeSample | null = null;

    for (const sample of this.samples) {
      const behind = newest.distance - sample.distance;

      if (behind >= gradeMinSpan && behind <= gradeMaxSpan) {
        oldest = sample;
      }
    }

    if (oldest === null) {
      return null;
    }

    const span = newest.distance - oldest.distance;

    return span < gradeMinDelta ? null : (newest.altitude - oldest.altitude) / span;
  }

  /** The smoothed grade, rounded to four decimals, 0 before any qualifying stretch. */
  value(): number {
    return Math.round(this.grade * 10_000) / 10_000;
  }

  reset() {
    this.samples = [];
    this.grade = 0;
  }
}

/** The five rider numbers of one second, after sanitization. */
type Second = { power: number; heartrate: number; speed: number; cadence: number; draft: number };
/** A missing, negative or otherwise unusable reading counts as zero; a NaN would poison every sum. */
const readable = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);

/**
The zone one wattage falls in, as an index into the zones of one FTP: `from` is exclusive and `to` is
inclusive, so a reading exactly on a boundary stays in the lower zone; watts at or under zero are
rest, the first zone.
*/
const zoneOf = (power: number, zones: ReadonlyArray<PowerZone>): number => {
  const index = zones.findIndex((zone) => power <= (zone.to ?? Infinity));

  return index === -1 ? zones.length - 1 : index;
};

/** The seconds collected since the last `startLap`. */
type LapTally = {
  active: number;
  powerSum: number;
  powerMax: number;
  heartRateSum: number;
  heartRateCount: number;
  heartRateMax: number;
  speedSum: number;
  speedMax: number;
  draftSum: number;
  draftMax: number;
  cadenceSum: number;
  cadenceCount: number;
  cadenceMax: number;
};

const emptyLap = (): LapTally => ({
  active: 0,
  powerSum: 0,
  powerMax: 0,
  heartRateSum: 0,
  heartRateCount: 0,
  heartRateMax: 0,
  speedSum: 0,
  speedMax: 0,
  draftSum: 0,
  draftMax: 0,
  cadenceSum: 0,
  cadenceCount: 0,
  cadenceMax: 0,
});

const emptyLapSnapshot = (): LapSnapshot => ({
  power: { avg: 0, max: 0 },
  speed: { avg: 0, max: 0 },
  hr: { avg: 0, max: 0 },
  cadence: { avg: 0, max: 0 },
  draft: { avg: 0, max: 0 },
  activeTime: 0,
});

/**
The seconds of riding spent in each power zone. Like the W' balance, the watts of every second are
remembered instead of being folded into the zones at once, because the FTP that sets the boundaries
can be edited mid-ride and the same ride is shown at FTP 0 to a viewer who may not see it: with an
unchanged FTP only the seconds pushed since the last answer are added, otherwise the ride is replayed
from second zero.
*/
class ZoneTimes {
  private readonly powers: Array<number> = [];

  /** The FTP and zone model the remembered seconds were folded at, '' when none of them were. */
  private foldedKey = '';

  /** How many of the remembered seconds the `seconds` below already contain. */
  private folded = 0;

  private seconds: Array<number> = [];

  /** Appends the next second of the ride; an unreadable wattage counts as zero. */
  push(power: number) {
    this.powers.push(readable(power));
  }

  /** Forgets the ride completely. */
  reset() {
    this.powers.length = 0;
    this.foldedKey = '';
    this.folded = 0;
    this.seconds = [];
  }

  /**
  One entry per zone of `powerZones(ftp)`, in that order, with the seconds of the ride spent in it;
  empty when `ftp` is not a finite number above zero, exactly as the W' balance stays null then.
  */
  value(ftp: number): Array<PowerZoneTime> {
    if (!Number.isFinite(ftp) || ftp <= 0) {
      return [];
    }

    const zones = powerZones(ftp);

    const key = `${ftp}/${zonesRevision()}`;

    if (key !== this.foldedKey) {
      this.foldedKey = key;
      this.folded = 0;
      this.seconds = zones.map(() => 0);
    }

    for (; this.folded < this.powers.length; this.folded += 1) {
      const power = this.powers[this.folded] ?? 0;
      const zone = zoneOf(power, zones);

      this.seconds[zone] = (this.seconds[zone] ?? 0) + 1;

      // An overlapping zone (the sweet spot) is counted next to the zone the reading is in.
      for (const [index, entry] of zones.entries()) {
        if (entry.overlap === true && index !== zone && power > entry.from && power <= (entry.to ?? Infinity)) {
          this.seconds[index] = (this.seconds[index] ?? 0) + 1;
        }
      }
    }

    return zones.map((entry, index) => ({ zone: entry.zone, time: this.seconds[index] ?? 0 }));
  }
}

/**
The sliding windows of one metric: one `PeakTracker` per period in `peakPeriods`. The same trackers
answer both questions we ask of a metric: `smooth` reads the average of the current window, `peaks`
reads the best window seen so far. Windows that have not filled yet report nothing.
*/
class MetricWindows {
  private readonly trackers: Array<PeakTracker>;

  private readonly shorter: Array<PeakTracker>;

  constructor() {
    this.trackers = peakPeriods.map((period) => new PeakTracker(period));

    const byPeriod = new Map<number, PeakTracker>(this.trackers.map((tracker) => [tracker.period, tracker]));

    this.shorter = smoothPeriods.flatMap((period) => {
      const tracker = byPeriod.get(period);

      return tracker === undefined ? [] : [tracker];
    });
  }

  push(value: number) {
    for (const tracker of this.trackers) {
      tracker.push(value);
    }
  }

  get smooth(): Array<PeriodAverage> {
    return this.shorter.flatMap((tracker) =>
      tracker.current === null ? [] : { period: tracker.period, avg: tracker.current },
    );
  }

  get peaks(): Array<PeriodAverage> {
    return this.trackers.flatMap((tracker) =>
      tracker.peak === null ? [] : { period: tracker.period, avg: tracker.peak },
    );
  }

  reset() {
    for (const tracker of this.trackers) {
      tracker.reset();
    }
  }
}

/**
Ride statistics as seen by one rider, second by second. Samples arrive at whatever rate the source
sends them, so every sample is snapped to its whole second and the ride is measured in seconds: one
sample per second feeds every window, sum and counter exactly once.
*/
export class RiderStats {
  private readonly powerWindows = new MetricWindows();

  private readonly heartRateWindows = new MetricWindows();

  private readonly speedWindows = new MetricWindows();

  private readonly draftWindows = new MetricWindows();

  private readonly normalizedPower = new NormalizedPower();

  private readonly npWindows = [new WindowedNormalizedPower(300), new WindowedNormalizedPower(1200)];

  private readonly wPrime = new WPrimeBalance();

  private readonly zoneTimes = new ZoneTimes();

  private readonly gradeTracker = new GradeTracker();

  private started = false;

  /** wall-clock millisecond epoch of the first accepted sample, null until one arrives. */
  private createdAt: number | null = null;

  private firstSec = 0;

  private lastSec = 0;

  private active = 0;

  private powerSum = 0;

  private powerMax = 0;

  private heartRateSum = 0;

  private heartRateCount = 0;

  private heartRateMax = 0;

  private speedSum = 0;

  private speedMax = 0;

  private draftSum = 0;

  private draftMax = 0;

  private cadenceSum = 0;

  private cadenceCount = 0;

  private cadenceMax = 0;

  private previous: Second | null = null;

  private lap: LapTally = emptyLap();

  private lastLap: LapSnapshot = emptyLapSnapshot();

  /** The laps already ended, oldest first. */
  private finishedLaps: Array<LapSpan> = [];

  /** The first second of the lap still running. */
  private lapStartSec = 0;

  /** The id the running lap has, and the id the next finished lap gets. */
  private nextLapId = 1;

  /**
  A sample whose own time is unusable is dropped whole: without a second there is nothing to place
  it in. A short gap is riding that stopped reporting, so the missing seconds are filled with the
  last known values; a long gap is a pause, and pausing costs elapsed time but no active time.
  */
  push(sample: StatsSample) {
    if (!Number.isFinite(sample.time)) {
      return;
    }

    if (sample.distance !== undefined && sample.yAltitude !== undefined) {
      // The altitude formula of `world/streams`; the 9000 cm offset cancels in a difference anyway.
      this.gradeTracker.push(sample.distance, (sample.yAltitude - 9000) / 100);
    }

    const sec = Math.floor(sample.time / 1000);
    const second: Second = {
      power: readable(sample.power),
      heartrate: readable(sample.heartrate),
      speed: readable(sample.speed),
      cadence: readable(sample.cadence),
      draft: readable(sample.draft ?? 0),
    };

    if (!this.started) {
      this.started = true;
      this.createdAt = Date.now();
      this.firstSec = sec;
      this.lastSec = sec;
      this.lapStartSec = sec;
      this.addSecond(second);

      return;
    }

    if (sec <= this.lastSec) {
      return;
    }

    const gap = sec - this.lastSec;

    if (gap <= maxGap) {
      for (let filled = 1; filled < gap; filled += 1) {
        this.addSecond(this.previous ?? second);
      }
    }

    this.lastSec = sec;
    this.addSecond(second);
  }

  /** Ends the current lap; an empty lap is not recorded, so a stray press costs nothing. */
  startLap() {
    if (this.lap.active > 0) {
      this.lastLap = this.lapSnapshot();
      this.finishedLaps.push({ id: this.nextLapId, startSec: this.lapStartSec, endSec: this.lastSec });
      this.nextLapId += 1;
      this.lapStartSec = this.lastSec + 1;
    }

    this.lap = emptyLap();
  }

  /**
  Where every lap of the ride began and ended: the finished laps, oldest first, followed by the lap
  still running with `endSec: null`. Empty before the first sample; the returned objects are copies.
  */
  lapSpans(): Array<LapSpan> {
    if (!this.started) {
      return [];
    }

    const running: LapSpan = { id: this.nextLapId, startSec: this.lapStartSec, endSec: null };

    return [...this.finishedLaps.map((span) => ({ ...span })), running];
  }

  /** Forgets the ride completely, down to the recorded laps. */
  reset() {
    this.powerWindows.reset();
    this.heartRateWindows.reset();
    this.speedWindows.reset();
    this.draftWindows.reset();
    this.normalizedPower.reset();
    for (const window of this.npWindows) {
      window.reset();
    }
    this.wPrime.reset();
    this.zoneTimes.reset();
    this.gradeTracker.reset();

    this.started = false;
    this.createdAt = null;
    this.firstSec = 0;
    this.lastSec = 0;
    this.active = 0;
    this.powerSum = 0;
    this.powerMax = 0;
    this.heartRateSum = 0;
    this.heartRateCount = 0;
    this.heartRateMax = 0;
    this.speedSum = 0;
    this.speedMax = 0;
    this.draftSum = 0;
    this.draftMax = 0;
    this.cadenceSum = 0;
    this.cadenceCount = 0;
    this.cadenceMax = 0;
    this.previous = null;
    this.lap = emptyLap();
    this.lastLap = emptyLapSnapshot();
    this.finishedLaps = [];
    this.lapStartSec = 0;
    this.nextLapId = 1;
  }

  /** Everything a screen or a recap needs; `ftp` only scales the training stress score, the W' balance
  and the power zone times, and hides the last two whenever it is not a finite number above zero. */
  snapshot(ftp: number): StatsSnapshot {
    const np = this.normalizedPower.value;

    return {
      activeTime: this.active,
      elapsedTime: this.started ? this.lastSec - this.firstSec + 1 : 0,
      power: {
        avg: this.active === 0 ? 0 : this.powerSum / this.active,
        smooth: this.powerWindows.smooth,
        peaks: this.powerWindows.peaks,
        max: this.powerMax,
        np,
        tss: ftp > 0 && np > 0 ? ((this.active * np * (np / ftp)) / (ftp * 3600)) * 100 : 0,
        kj: this.powerSum / 1000,
        wBal: this.wPrime.value(ftp, defaultWPrime),
      },
      speed: {
        avg: this.active === 0 ? 0 : this.speedSum / this.active,
        max: this.speedMax,
        smooth: this.speedWindows.smooth,
        peaks: this.speedWindows.peaks,
      },
      hr: {
        avg: this.heartRateCount === 0 ? 0 : this.heartRateSum / this.heartRateCount,
        max: this.heartRateMax,
        smooth: this.heartRateWindows.smooth,
        peaks: this.heartRateWindows.peaks,
      },
      draft: {
        avg: this.active === 0 ? 0 : this.draftSum / this.active,
        max: this.draftMax,
        smooth: this.draftWindows.smooth,
        peaks: this.draftWindows.peaks,
        current: this.previous?.draft ?? 0,
        kj: this.draftSum / 1000,
      },
      cadence: {
        avg: this.cadenceCount === 0 ? 0 : this.cadenceSum / this.cadenceCount,
        max: this.cadenceMax,
      },
      timeInPowerZones: this.zoneTimes.value(ftp),
      grade: this.gradeTracker.value(),
      lapCount: this.nextLapId,
      npSmooth: this.npWindows.flatMap((window) =>
        window.current === null ? [] : { period: window.period, avg: window.current },
      ),
      lap: this.lapSnapshot(),
      lastLap: this.lastLap,
      created: this.createdAt ?? 0,
    };
  }

  /** One second of riding: every window, sum and counter moves by exactly this second. */
  private addSecond(second: Second) {
    this.active += 1;

    this.powerWindows.push(second.power);
    this.heartRateWindows.push(second.heartrate);
    this.speedWindows.push(second.speed);
    this.draftWindows.push(second.draft);
    this.normalizedPower.push(second.power);
    for (const window of this.npWindows) {
      window.push(second.power);
    }
    this.wPrime.push(second.power);
    this.zoneTimes.push(second.power);

    this.powerSum += second.power;
    this.powerMax = Math.max(this.powerMax, second.power);
    this.speedSum += second.speed;
    this.speedMax = Math.max(this.speedMax, second.speed);
    this.draftSum += second.draft;
    this.draftMax = Math.max(this.draftMax, second.draft);

    if (second.heartrate > 0) {
      this.heartRateSum += second.heartrate;
      this.heartRateCount += 1;
      this.heartRateMax = Math.max(this.heartRateMax, second.heartrate);
    }

    if (second.cadence > 0) {
      this.cadenceSum += second.cadence;
      this.cadenceCount += 1;
      this.cadenceMax = Math.max(this.cadenceMax, second.cadence);
    }

    this.lap.active += 1;
    this.lap.powerSum += second.power;
    this.lap.powerMax = Math.max(this.lap.powerMax, second.power);
    this.lap.speedSum += second.speed;
    this.lap.speedMax = Math.max(this.lap.speedMax, second.speed);
    this.lap.draftSum += second.draft;
    this.lap.draftMax = Math.max(this.lap.draftMax, second.draft);

    if (second.heartrate > 0) {
      this.lap.heartRateSum += second.heartrate;
      this.lap.heartRateCount += 1;
      this.lap.heartRateMax = Math.max(this.lap.heartRateMax, second.heartrate);
    }

    if (second.cadence > 0) {
      this.lap.cadenceSum += second.cadence;
      this.lap.cadenceCount += 1;
      this.lap.cadenceMax = Math.max(this.lap.cadenceMax, second.cadence);
    }

    this.previous = second;
  }

  private lapSnapshot(): LapSnapshot {
    return {
      power: {
        avg: this.lap.active === 0 ? 0 : this.lap.powerSum / this.lap.active,
        max: this.lap.powerMax,
      },
      speed: {
        avg: this.lap.active === 0 ? 0 : this.lap.speedSum / this.lap.active,
        max: this.lap.speedMax,
      },
      hr: {
        avg: this.lap.heartRateCount === 0 ? 0 : this.lap.heartRateSum / this.lap.heartRateCount,
        max: this.lap.heartRateMax,
      },
      cadence: {
        avg: this.lap.cadenceCount === 0 ? 0 : this.lap.cadenceSum / this.lap.cadenceCount,
        max: this.lap.cadenceMax,
      },
      draft: {
        avg: this.lap.active === 0 ? 0 : this.lap.draftSum / this.lap.active,
        max: this.lap.draftMax,
      },
      activeTime: this.lap.active,
    };
  }
}
