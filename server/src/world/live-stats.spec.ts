import { peakPeriods, RiderStats, smoothPeriods } from '#src/world/live-stats';
import type { StatsSample } from '#src/world/live-stats';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

const start = 1_000_000;

/** The whole game second of `sampleAt(0)`; lap spans are counted in these seconds. */
const firstSec = start / 1000;

/** One second of riding at whole second `second`, with missing metrics left at zero. */
const sampleAt = (second: number, values: Partial<Omit<StatsSample, 'time'>> = {}): StatsSample => ({
  time: start + second * 1000,
  power: 0,
  heartrate: 0,
  speed: 0,
  cadence: 0,
  ...values,
});

/** `count` identical seconds starting at whole second `from`. */
const ride = (stats: RiderStats, from: number, count: number, values: Partial<Omit<StatsSample, 'time'>>) => {
  for (let second = from; second < from + count; second += 1) {
    stats.push(sampleAt(second, values));
  }
};

/** The `avg` recorded for `period` in `entries`, or undefined when that period is not there. */
const periodAverage = (entries: ReadonlyArray<{ period: number; avg: number }>, period: number) =>
  entries.find((entry) => entry.period === period)?.avg;

const periodsOf = (entries: ReadonlyArray<{ period: number; avg: number }>) => entries.map((entry) => entry.period);

await test('a steady ride reports its own numbers and only the windows that have filled', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 100, { power: 200, heartrate: 140, speed: 30, cadence: 90 });

  const steady = stats.snapshot(200);

  assert.equal(steady.activeTime, 100);
  assert.equal(steady.elapsedTime, 100);
  assert.equal(steady.power.avg, 200);
  assert.equal(steady.power.max, 200);
  assert.ok(Math.abs(steady.power.np - 200) <= 1e-9);
  assert.ok(Math.abs(steady.power.kj - 20) <= 1e-9);
  assert.equal(steady.hr.avg, 140);
  assert.equal(steady.speed.avg, 30);
  assert.equal(steady.cadence.avg, 90);

  assert.deepEqual(periodsOf(steady.power.smooth), [5, 15, 60]);
  assert.deepEqual(periodsOf(steady.power.peaks), [5, 15, 60]);

  for (const period of [5, 15, 60]) {
    assert.equal(periodAverage(steady.power.smooth, period), 200);
    assert.equal(periodAverage(steady.power.peaks, period), 200);
    assert.equal(periodAverage(steady.hr.smooth, period), 140);
    assert.equal(periodAverage(steady.hr.peaks, period), 140);
    assert.equal(periodAverage(steady.speed.smooth, period), 30);
    assert.equal(periodAverage(steady.speed.peaks, period), 30);
  }

  for (const period of [300, 1200]) {
    assert.equal(periodAverage(steady.power.smooth, period), undefined);
    assert.equal(periodAverage(steady.power.peaks, period), undefined);
  }

  assert.equal(periodAverage(steady.power.peaks, 3600), undefined);
});

await test(
  'an hour at 250 W for a rider with an ftp of 250 is 100 TSS and keeps its hour record',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 3600, { power: 250 });

    const againstFtp = stats.snapshot(250);

    assert.ok(Math.abs(againstFtp.power.tss - 100) <= 1e-6);
    assert.deepEqual(periodsOf(againstFtp.power.peaks), [...peakPeriods]);
    assert.deepEqual(periodsOf(againstFtp.power.smooth), [...smoothPeriods]);
    assert.equal(periodAverage(againstFtp.power.peaks, 3600), 250);

    assert.equal(stats.snapshot(0).power.tss, 0);
    assert.equal(new RiderStats().snapshot(250).power.tss, 0);
  },
);

await test(
  'a gap of up to six seconds is filled with the last known values, so the ride keeps running',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    stats.push(sampleAt(0, { power: 100 }));
    stats.push(sampleAt(1, { power: 100 }));
    stats.push(sampleAt(5, { power: 300 }));

    const filled = stats.snapshot(200);

    assert.equal(filled.activeTime, 6);
    assert.equal(filled.elapsedTime, 6);
    assert.ok(Math.abs(filled.power.avg - (100 * 5 + 300) / 6) <= 1e-9);

    const widestGap = new RiderStats();

    widestGap.push(sampleAt(0, { power: 100 }));
    widestGap.push(sampleAt(6, { power: 300 }));

    assert.equal(widestGap.snapshot(200).activeTime, 7);
    assert.equal(widestGap.snapshot(200).elapsedTime, 7);
    assert.ok(Math.abs(widestGap.snapshot(200).power.avg - (100 * 6 + 300) / 7) <= 1e-9);
  },
);

await test('a gap longer than six seconds is a pause that costs active time', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  stats.push(sampleAt(0, { power: 100 }));
  stats.push(sampleAt(20, { power: 300 }));

  const paused = stats.snapshot(200);

  assert.equal(paused.activeTime, 2);
  assert.equal(paused.elapsedTime, 21);
  assert.equal(paused.power.avg, 200);
});

await test('a repeated or a backward sample is ignored', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  stats.push(sampleAt(3, { power: 100 }));
  stats.push(sampleAt(3, { power: 900 }));

  assert.equal(stats.snapshot(200).activeTime, 1);
  assert.equal(stats.snapshot(200).elapsedTime, 1);
  assert.equal(stats.snapshot(200).power.avg, 100);

  stats.push(sampleAt(2, { power: 900 }));

  assert.equal(stats.snapshot(200).activeTime, 1);
  assert.equal(stats.snapshot(200).power.avg, 100);

  stats.push(sampleAt(4, { power: 300 }));

  assert.equal(stats.snapshot(200).activeTime, 2);
  assert.equal(stats.snapshot(200).elapsedTime, 2);
  assert.equal(stats.snapshot(200).power.avg, 200);
});

await test('unreadable readings count as zero and leave every following average finite', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 4, { power: 200, heartrate: 140, speed: 30, cadence: 90 });

  stats.push(sampleAt(4, { power: notANumber, heartrate: notANumber, speed: notANumber, cadence: notANumber }));
  stats.push(sampleAt(5, { power: Infinity, heartrate: -10, speed: -1, cadence: -50 }));
  stats.push(sampleAt(6, { power: -42, heartrate: 0, speed: 0, cadence: 0 }));

  ride(stats, 7, 3, { power: 200, heartrate: 140, speed: 30, cadence: 90 });

  const read = stats.snapshot(200);

  assert.equal(read.activeTime, 10);
  assert.equal(read.elapsedTime, 10);
  assert.ok(Number.isFinite(read.power.avg));
  assert.ok(Number.isFinite(read.hr.avg));
  assert.ok(Number.isFinite(read.speed.avg));
  assert.ok(Number.isFinite(read.cadence.avg));
  assert.ok(Number.isFinite(read.power.np));
  assert.equal(read.power.max, 200);
  assert.ok(Math.abs(read.power.avg - (200 * 7) / 10) <= 1e-9);
  assert.ok(Math.abs(read.hr.avg - 140) <= 1e-9);
  assert.ok(Math.abs(read.cadence.avg - 90) <= 1e-9);
  assert.ok(Math.abs(read.speed.avg - (30 * 7) / 10) <= 1e-9);

  for (const entry of [...read.power.smooth, ...read.power.peaks, ...read.hr.smooth, ...read.hr.peaks]) {
    assert.ok(Number.isFinite(entry.avg));
  }

  assert.equal(read.lap.activeTime, 10);
  assert.ok(Number.isFinite(read.lap.power.avg));
  assert.ok(Number.isFinite(read.lap.hr.avg));
});

await test('a sample without a usable time is dropped whole', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  stats.push({ time: notANumber, power: 200, heartrate: 140, speed: 30, cadence: 90 });
  stats.push({ time: Infinity, power: 200, heartrate: 140, speed: 30, cadence: 90 });

  assert.deepEqual(stats.snapshot(200), new RiderStats().snapshot(200));

  stats.push(sampleAt(0, { power: 100 }));

  assert.equal(stats.snapshot(200).activeTime, 1);
  assert.equal(stats.snapshot(200).elapsedTime, 1);
});

await test('created stamps the first sample and a reset stamps the next ride again', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  assert.equal(stats.snapshot(200).created, 0);

  ride(stats, 0, 10, { power: 100 });

  const before = stats.snapshot(200).created;

  assert.ok(Number.isFinite(before) && before > 0);
  assert.ok(before >= Date.now() - 5000 && before <= Date.now());

  ride(stats, 10, 10, { power: 200 });

  assert.equal(stats.snapshot(200).created, before);

  stats.reset();

  assert.equal(stats.snapshot(200).created, 0);

  stats.push(sampleAt(20, { power: 100 }));

  assert.ok(stats.snapshot(200).created >= before);
});

await test('a lap starts where the previous one ended and an empty press changes nothing', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 10, { power: 100, heartrate: 100, speed: 20, cadence: 60 });
  stats.startLap();
  ride(stats, 10, 10, { power: 300, heartrate: 160, speed: 40, cadence: 100 });

  const laps = stats.snapshot(200);

  assert.equal(laps.lap.power.avg, 300);
  assert.equal(laps.lap.activeTime, 10);
  assert.equal(laps.lap.hr.avg, 160);
  assert.equal(laps.lap.speed.avg, 40);
  assert.equal(laps.lap.draft.avg, 0);
  assert.equal(laps.lastLap.power.avg, 100);
  assert.equal(laps.lastLap.activeTime, 10);
  assert.equal(laps.lastLap.hr.avg, 100);
  assert.equal(laps.lastLap.speed.avg, 20);
  assert.equal(laps.lastLap.draft.avg, 0);

  stats.startLap();

  const pressed = stats.snapshot(200);

  assert.equal(pressed.lap.activeTime, 0);
  assert.equal(pressed.lap.power.avg, 0);
  assert.equal(pressed.lap.hr.avg, 0);
  assert.equal(pressed.lap.speed.avg, 0);
  assert.equal(pressed.lastLap.power.avg, 300);
  assert.equal(pressed.lastLap.activeTime, 10);

  stats.startLap();
  stats.startLap();

  assert.deepEqual(stats.snapshot(200).lastLap, pressed.lastLap);
  assert.equal(stats.snapshot(200).lap.activeTime, 0);

  ride(stats, 20, 5, { power: 250 });

  assert.equal(stats.snapshot(200).lap.activeTime, 5);
  assert.equal(stats.snapshot(200).lap.power.avg, 250);
  assert.equal(stats.snapshot(200).lastLap.power.avg, 300);
});

await test('a reset forgets the ride completely', { timeout: 10_000 }, () => {
  const fresh = new RiderStats();
  const stats = new RiderStats();

  ride(stats, 0, 120, { power: 250, heartrate: 150, speed: 35, cadence: 95 });
  stats.startLap();
  ride(stats, 120, 60, { power: 300, heartrate: 160, speed: 40, cadence: 100 });

  assert.notDeepEqual(stats.snapshot(200), fresh.snapshot(200));

  stats.reset();

  assert.deepEqual(stats.snapshot(200), fresh.snapshot(200));

  stats.push(sampleAt(0, { power: 100 }));

  const after = stats.snapshot(200);

  assert.equal(after.activeTime, 1);
  assert.equal(after.power.max, 100);
});

await test(
  'lap cadence: the session skips zero cadence in its average, the lap collects its own values',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 1, { power: 100, heartrate: 120, speed: 20, cadence: 80 });
    ride(stats, 1, 1, { power: 300, heartrate: 160, speed: 30, cadence: 0 });
    ride(stats, 2, 1, { power: 200, heartrate: 140, speed: 25, cadence: 100 });

    stats.startLap();

    ride(stats, 3, 1, { power: 150, heartrate: 130, speed: 22, cadence: 70 });
    ride(stats, 4, 1, { power: 250, heartrate: 150, speed: 28, cadence: 90 });

    const session = stats.snapshot(250);

    assert.equal(session.power.max, 300);
    assert.equal(session.hr.max, 160);
    assert.equal(session.speed.max, 30);
    assert.equal(session.cadence.max, 100);
    assert.ok(Math.abs(session.cadence.avg - (80 + 100 + 70 + 90) / 4) <= 1e-9);

    assert.equal(session.lap.power.max, 250);
    assert.equal(session.lap.hr.max, 150);
    assert.equal(session.lap.speed.max, 28);
    assert.equal(session.lap.cadence.max, 90);
    assert.ok(Math.abs(session.lap.cadence.avg - 80) <= 1e-9);

    stats.startLap();

    const fresh = stats.snapshot(250);

    assert.equal(fresh.lap.power.max, 0);
    assert.equal(fresh.lap.hr.max, 0);
    assert.equal(fresh.lap.speed.max, 0);
    assert.equal(fresh.lap.cadence.max, 0);
    assert.equal(fresh.lap.cadence.avg, 0);
    assert.equal(fresh.lastLap.power.max, 250);
    assert.equal(fresh.lastLap.hr.max, 150);
    assert.equal(fresh.lastLap.speed.max, 28);
    assert.equal(fresh.lastLap.cadence.max, 90);
    assert.ok(Math.abs(fresh.lastLap.cadence.avg - 80) <= 1e-9);
    assert.equal(fresh.lastLap.activeTime, 2);
  },
);

await test(
  'sixty seconds a hundred watts over the ftp drain exactly six kilojoules of W prime',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 60, { power: 350 });

    assert.equal(stats.snapshot(250).power.wBal, 20_000 - 6000);
  },
);

await test('a viewer who may not use the ftp sees no W prime balance at all', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 60, { power: 350 });

  assert.equal(stats.snapshot(0).power.wBal, null);
});

await test(
  'a W prime balance asked with another ftp equals a fresh computation with that ftp',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 90, { power: 400 });

    assert.equal(stats.snapshot(300).power.wBal, 20_000 - 90 * 100);

    const againstOtherFtp = new RiderStats();

    ride(againstOtherFtp, 0, 90, { power: 400 });

    assert.equal(stats.snapshot(250).power.wBal, againstOtherFtp.snapshot(250).power.wBal);

    ride(stats, 90, 30, { power: 200 });

    const continued = new RiderStats();

    ride(continued, 0, 90, { power: 400 });
    ride(continued, 90, 30, { power: 200 });

    assert.equal(stats.snapshot(250).power.wBal, continued.snapshot(250).power.wBal);
  },
);

await test('a reset refills the W prime balance', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 60, { power: 350 });

  assert.equal(stats.snapshot(250).power.wBal, 14_000);

  stats.reset();

  assert.equal(stats.snapshot(250).power.wBal, 20_000);

  ride(stats, 0, 10, { power: 350 });

  assert.equal(stats.snapshot(250).power.wBal, 20_000 - 1000);
});

await test('the seconds filled into a short gap are drained from the W prime balance too', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  stats.push(sampleAt(0, { power: 350 }));
  stats.push(sampleAt(5, { power: 350 }));

  // Six seconds of riding: the sample at second 0, four filled seconds, the sample at second 5.
  assert.equal(stats.snapshot(250).power.wBal, 20_000 - 6 * 100);
});

await test('a sample without a draft leaves every draft number at zero', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 100, { power: 200, heartrate: 140, speed: 30, cadence: 90 });

  const quiet = stats.snapshot(200);

  assert.equal(quiet.draft.avg, 0);
  assert.equal(quiet.draft.max, 0);
  assert.equal(quiet.draft.current, 0);
  assert.equal(quiet.draft.kj, 0);
  // The windows fill with zeros like any other metric, so their averages exist and are 0.
  for (const period of [5, 15, 60]) {
    assert.equal(periodAverage(quiet.draft.smooth, period), 0);
    assert.equal(periodAverage(quiet.draft.peaks, period), 0);
  }
  assert.equal(quiet.lap.draft.avg, 0);
  assert.equal(quiet.lap.draft.max, 0);
  assert.equal(new RiderStats().snapshot(200).draft.current, 0);
});

await test(
  'ten seconds of 30 draft watts report their average, their maximum, their energy and their current',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 10, { power: 200, speed: 30, draft: 30 });

    const drafting = stats.snapshot(200);

    assert.equal(drafting.draft.avg, 30);
    assert.equal(drafting.draft.max, 30);
    assert.equal(drafting.draft.current, 30);
    assert.ok(Math.abs(drafting.draft.kj - 0.3) <= 1e-9);
  },
);

await test(
  'falling back leaves the current draft at zero but keeps the maximum of the ride',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 10, { power: 200, speed: 30, draft: 30 });
    stats.push(sampleAt(10, { power: 200, speed: 30, draft: 0 }));

    const alone = stats.snapshot(200);

    assert.equal(alone.draft.current, 0);
    assert.equal(alone.draft.max, 30);
    assert.ok(Math.abs(alone.draft.avg - (30 * 10) / 11) <= 1e-9);
  },
);

await test(
  'the draft windows smooth and peak exactly like the speed ones: a constant 30 W fills the five second window with 30',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 10, { power: 200, speed: 30, draft: 30 });

    const drafting = stats.snapshot(200);

    assert.deepEqual(periodsOf(drafting.draft.smooth), [5]);
    assert.deepEqual(periodsOf(drafting.draft.peaks), [5]);
    assert.equal(periodAverage(drafting.draft.smooth, 5), 30);
    assert.equal(periodAverage(drafting.draft.peaks, 5), 30);

    for (const period of [15, 60]) {
      assert.equal(periodAverage(drafting.draft.smooth, period), undefined);
      assert.equal(periodAverage(drafting.draft.peaks, period), undefined);
    }
  },
);

await test('a lap keeps its own draft average and maximum, and a new lap starts from zero', { timeout: 10_000 }, () => {
  const stats = new RiderStats();

  ride(stats, 0, 10, { power: 200, speed: 30, draft: 30 });
  stats.startLap();
  ride(stats, 10, 5, { power: 250, speed: 35, draft: 10 });
  stats.push(sampleAt(15, { power: 250, speed: 35, draft: 40 }));

  const laps = stats.snapshot(200);

  assert.ok(Math.abs(laps.lap.draft.avg - (10 * 5 + 40) / 6) <= 1e-9);
  assert.equal(laps.lap.draft.max, 40);
  assert.equal(laps.lastLap.draft.avg, 30);
  assert.equal(laps.lastLap.draft.max, 30);

  stats.startLap();

  const fresh = stats.snapshot(200);

  assert.equal(fresh.lap.draft.avg, 0);
  assert.equal(fresh.lap.draft.max, 0);
});

await test(
  'the seconds filled into a short gap repeat the previous second, its draft included',
  {
    timeout: 10_000,
  },
  () => {
    const stats = new RiderStats();

    stats.push(sampleAt(0, { power: 200, speed: 30, draft: 40 }));
    stats.push(sampleAt(5, { power: 200, speed: 30, draft: 0 }));

    // Six seconds of riding: the sample at second 0, four filled seconds at 40 W, the sample at second 5.
    const filled = stats.snapshot(200);

    assert.equal(filled.activeTime, 6);
    assert.ok(Math.abs(filled.draft.avg - (40 * 5) / 6) <= 1e-9);
    assert.equal(filled.draft.max, 40);
    assert.equal(filled.draft.current, 0);
  },
);

await test('a reset forgets the draft completely', { timeout: 10_000 }, () => {
  const fresh = new RiderStats();
  const stats = new RiderStats();

  ride(stats, 0, 10, { power: 200, speed: 30, draft: 30 });

  assert.notDeepEqual(stats.snapshot(200), fresh.snapshot(200));

  stats.reset();

  assert.deepEqual(stats.snapshot(200), fresh.snapshot(200));

  stats.push(sampleAt(0, { power: 200, speed: 30, draft: 50 }));

  const after = stats.snapshot(200);

  assert.equal(after.draft.avg, 50);
  assert.equal(after.draft.max, 50);
  assert.equal(after.draft.current, 50);
});

await test(
  'a negative or NaN draft counts as zero and leaves every draft number finite',
  {
    timeout: 10_000,
  },
  () => {
    const stats = new RiderStats();

    stats.push(sampleAt(0, { power: 200, speed: 30, draft: -10 }));
    stats.push(sampleAt(1, { power: 200, speed: 30, draft: notANumber }));
    stats.push(sampleAt(2, { power: 200, speed: 30, draft: Infinity }));
    stats.push(sampleAt(3, { power: 200, speed: 30, draft: 20 }));

    const read = stats.snapshot(200);

    assert.equal(read.activeTime, 4);
    assert.equal(read.draft.max, 20);
    assert.ok(Math.abs(read.draft.avg - 20 / 4) <= 1e-9);
    assert.ok(Math.abs(read.draft.kj - 0.02) <= 1e-9);
    assert.ok(Number.isFinite(read.lap.draft.avg));
    assert.equal(read.lap.draft.max, 20);
  },
);

await test('the running lap spans from the first sample, and nothing exists before riding starts', () => {
  const stats = new RiderStats();

  assert.deepEqual(stats.lapSpans(), []);

  ride(stats, 4, 6, { power: 200 });

  assert.deepEqual(stats.lapSpans(), [{ id: 1, startSec: firstSec + 4, endSec: null }]);
});

await test('two startLap calls give three laps whose seconds are contiguous and never overlap', () => {
  const stats = new RiderStats();

  ride(stats, 0, 5, { power: 100 });
  stats.startLap();
  ride(stats, 5, 5, { power: 200 });
  stats.startLap();
  ride(stats, 10, 3, { power: 300 });

  assert.deepEqual(stats.lapSpans(), [
    { id: 1, startSec: firstSec + 0, endSec: firstSec + 4 },
    { id: 2, startSec: firstSec + 5, endSec: firstSec + 9 },
    { id: 3, startSec: firstSec + 10, endSec: null },
  ]);
});

await test('a startLap over an empty lap records nothing and moves nothing', () => {
  const stats = new RiderStats();

  ride(stats, 0, 5, { power: 100 });
  stats.startLap();

  const afterOne = stats.lapSpans();

  stats.startLap();

  assert.deepEqual(stats.lapSpans(), afterOne);
  assert.deepEqual(afterOne, [
    { id: 1, startSec: firstSec + 0, endSec: firstSec + 4 },
    { id: 2, startSec: firstSec + 5, endSec: null },
  ]);
});

await test('a gap-filled series keeps the lap boundaries on whole contiguous seconds', () => {
  const stats = new RiderStats();

  stats.push(sampleAt(0, { power: 100 }));
  stats.push(sampleAt(1, { power: 100 }));
  stats.push(sampleAt(4, { power: 100 }));
  stats.startLap();
  stats.push(sampleAt(5, { power: 200 }));

  assert.deepEqual(stats.lapSpans(), [
    { id: 1, startSec: firstSec + 0, endSec: firstSec + 4 },
    { id: 2, startSec: firstSec + 5, endSec: null },
  ]);
});

await test('reset forgets every span and the next ride starts again at lap 1', () => {
  const stats = new RiderStats();

  ride(stats, 0, 5, { power: 100 });
  stats.startLap();
  ride(stats, 5, 3, { power: 200 });

  assert.equal(stats.lapSpans().length, 2);

  stats.reset();

  assert.deepEqual(stats.lapSpans(), []);

  ride(stats, 100, 4, { power: 150 });
  stats.startLap();
  ride(stats, 104, 2, { power: 250 });

  assert.deepEqual(stats.lapSpans(), [
    { id: 1, startSec: firstSec + 100, endSec: firstSec + 103 },
    { id: 2, startSec: firstSec + 104, endSec: null },
  ]);
});

await test('lapSpans hands out copies that cannot reach the internals', () => {
  const stats = new RiderStats();

  ride(stats, 0, 5, { power: 100 });
  stats.startLap();
  ride(stats, 5, 2, { power: 200 });

  const spans = stats.lapSpans();
  const finished = spans[0];
  const running = spans[1];

  assert.ok(finished);
  assert.ok(running);

  spans.pop();
  finished.endSec = 999;
  running.startSec = 999;

  assert.deepEqual(stats.lapSpans(), [
    { id: 1, startSec: firstSec + 0, endSec: firstSec + 4 },
    { id: 2, startSec: firstSec + 5, endSec: null },
  ]);
});

const zoneTimesOf = (snapshot: { timeInPowerZones: Array<{ zone: string; time: number }> }) =>
  Object.fromEntries(snapshot.timeInPowerZones.map((entry) => [entry.zone, entry.time]));

await test(
  'the ride is also tallied per power zone, in the zone order and names of powerZones',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    // Against a 250 W FTP: Z1 up to 137.5 W, Z3 up to 225 W, Z5 up to 300 W.
    ride(stats, 0, 60, { power: 100 });
    ride(stats, 60, 30, { power: 200 });
    ride(stats, 90, 10, { power: 300 });
    ride(stats, 100, 5, { power: 137.5 });

    const zones = stats.snapshot(250).timeInPowerZones;

    assert.deepEqual(
      zones.map((entry) => entry.zone),
      ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'],
    );
    // The reading exactly on the Z1 ceiling stays in Z1.
    assert.deepEqual(zoneTimesOf(stats.snapshot(250)), { Z1: 65, Z2: 0, Z3: 30, Z4: 0, Z5: 10, Z6: 0, Z7: 0 });
    // Every active second lands in exactly one zone, so the times add up to the active time.
    assert.equal(
      zones.reduce((sum, entry) => sum + entry.time, 0),
      stats.snapshot(250).activeTime,
    );
  },
);

await test(
  'the zone times count the seconds filled into a short gap once, and an unknown ftp hides them',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    stats.push(sampleAt(0, { power: 300 }));
    stats.push(sampleAt(5, { power: 300 }));

    assert.deepEqual(zoneTimesOf(stats.snapshot(250)), { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 6, Z6: 0, Z7: 0 });
    // The same privacy rule as the W' balance: a viewer who may not use the FTP gets nothing.
    assert.deepEqual(stats.snapshot(0).timeInPowerZones, []);
    // A ride with no seconds yet still answers every zone, with no seconds in any of them.
    assert.deepEqual(zoneTimesOf(new RiderStats().snapshot(250)), { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0, Z6: 0, Z7: 0 });
  },
);

await test(
  'zone times asked with another ftp equal a fresh computation with that ftp, and a reset clears them',
  { timeout: 10_000 },
  () => {
    const stats = new RiderStats();

    ride(stats, 0, 60, { power: 250 });
    ride(stats, 60, 30, { power: 120 });

    assert.deepEqual(stats.snapshot(200).timeInPowerZones, stats.snapshot(200).timeInPowerZones);
    assert.deepEqual(
      stats.snapshot(200).timeInPowerZones.map((entry) => entry.zone),
      ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'],
    );
    assert.deepEqual(zoneTimesOf(stats.snapshot(200)), { Z1: 0, Z2: 30, Z3: 0, Z4: 0, Z5: 0, Z6: 60, Z7: 0 });

    const againstOtherFtp = new RiderStats();

    ride(againstOtherFtp, 0, 60, { power: 250 });
    ride(againstOtherFtp, 60, 30, { power: 120 });

    assert.deepEqual(stats.snapshot(200).timeInPowerZones, againstOtherFtp.snapshot(200).timeInPowerZones);

    ride(stats, 90, 20, { power: 400 });

    const continued = new RiderStats();

    ride(continued, 0, 60, { power: 250 });
    ride(continued, 60, 30, { power: 120 });
    ride(continued, 90, 20, { power: 400 });

    assert.deepEqual(stats.snapshot(300).timeInPowerZones, continued.snapshot(300).timeInPowerZones);

    stats.reset();

    assert.deepEqual(stats.snapshot(300).timeInPowerZones, stats.snapshot(300).timeInPowerZones);
    assert.deepEqual(zoneTimesOf(stats.snapshot(300)), { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0, Z6: 0, Z7: 0 });
    assert.deepEqual(stats.snapshot(0).timeInPowerZones, []);
  },
);

/**
`count` one second samples starting at whole second `from`, the ride covering `distanceAt(index)`
metres at raw `yAltitudeAt(index)` centimetres (the packet unit, with the 9000 offset).
*/
const climbRide = (
  stats: RiderStats,
  from: number,
  count: number,
  distanceAt: (index: number) => number,
  yAltitudeAt: (index: number) => number,
) => {
  for (let index = 0; index < count; index += 1) {
    stats.push(sampleAt(from + index, { power: 200, distance: distanceAt(index), yAltitude: yAltitudeAt(index) }));
  }
};

await test('the snapshot carries the smoothed grade of the climb stream samples', { timeout: 10_000 }, () => {
  // Twenty samples, 10 metres and 0.5 metres of altitude each: a steady 5% climb.
  const uphill = new RiderStats();

  climbRide(
    uphill,
    0,
    20,
    (index) => index * 10,
    (index) => 9000 + index * 50,
  );

  const grade = uphill.snapshot(200).grade;

  assert.ok(grade >= 0.04 && grade <= 0.06, `expected a 5% climb, got ${grade}`);

  // A flat ride keeps the grade at zero.
  const flat = new RiderStats();

  climbRide(
    flat,
    0,
    20,
    (index) => index * 10,
    () => 9000,
  );

  assert.ok(Math.abs(flat.snapshot(200).grade) < 0.005);

  // A downhill ride grades negative.
  const downhill = new RiderStats();

  climbRide(
    downhill,
    0,
    20,
    (index) => index * 10,
    (index) => 12_000 - index * 50,
  );

  assert.ok(downhill.snapshot(200).grade < 0);

  // A ride reset (distance jumping backwards) clears the buffer without throwing and keeps the grade.
  const kept = downhill.snapshot(200).grade;

  // The climb stream feeds distance and altitude on every sample, so the buffer remembers them even
  // when the sample itself is too old to be placed in a new second.
  assert.doesNotThrow(() => {
    climbRide(
      downhill,
      20,
      3,
      (index) => 5 - index * 10,
      (index) => 9000 + index * 50,
    );
  });

  assert.equal(downhill.snapshot(200).grade, kept);
});
