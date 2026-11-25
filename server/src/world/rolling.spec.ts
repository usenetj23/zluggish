import { NormalizedPower, PeakTracker, RollingWindow, WindowedNormalizedPower } from '#src/world/rolling';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const window = 30;

/** `count` copies of `value`, so a test sequence reads like the ride it describes. */
const repeated = (value: number, count: number) => Array.from({ length: count }, () => value);

/** A deterministic sequence of powers between 100 and 400 W; no Math.random, so a failure reproduces. */
const powers = () => {
  const values: Array<number> = [];

  let state = 1;

  for (let index = 0; index < 500; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    values.push(100 + (state % 30_000) / 100);
  }

  return values;
};

/** The average of the last `size` samples, recomputed from scratch at every step. */
const bruteForceMean = (values: ReadonlyArray<number>, index: number, size: number) => {
  const latest = values.slice(Math.max(0, index - size + 1), index + 1);

  return latest.reduce((sum, value) => sum + value, 0) / latest.length;
};

/** Normalized Power as the plain textbook loop over the whole sample list. */
const bruteForceNormalizedPower = (values: ReadonlyArray<number>) => {
  const fourthPowers: Array<number> = [];

  for (let start = 0; start + window <= values.length; start += 1) {
    const mean = values.slice(start, start + window).reduce((sum, value) => sum + value, 0) / window;
    fourthPowers.push(mean ** 4);
  }

  if (fourthPowers.length === 0) {
    return 0;
  }

  return (fourthPowers.reduce((sum, value) => sum + value, 0) / fourthPowers.length) ** 0.25;
};

await test('a rolling window averages what it holds and drops the oldest sample when full', { timeout: 10_000 }, () => {
  const samples = new RollingWindow(3);

  assert.equal(samples.count, 0);
  assert.equal(samples.full, false);
  assert.equal(samples.mean, 0);

  samples.push(1);
  assert.equal(samples.count, 1);
  assert.equal(samples.mean, 1);

  samples.push(2);
  assert.equal(samples.count, 2);
  assert.equal(samples.full, false);
  assert.equal(samples.mean, 1.5);

  samples.push(3);
  assert.equal(samples.full, true);
  assert.equal(samples.mean, 2);

  samples.push(4);
  assert.equal(samples.count, 3);
  assert.equal(samples.mean, 3);

  samples.reset();
  assert.equal(samples.count, 0);
  assert.equal(samples.full, false);
  assert.equal(samples.mean, 0);
});

await test('a rolling window rejects sizes that are not whole numbers of samples', { timeout: 10_000 }, () => {
  for (const size of [0, -1, 2.5]) {
    assert.throws(() => new RollingWindow(size), RangeError);
  }
});

await test(
  'the rolling mean matches a brute-force average of the last 30 samples at every step',
  { timeout: 10_000 },
  () => {
    const values = powers();
    const samples = new RollingWindow(window);

    for (const [index, value] of values.entries()) {
      samples.push(value);

      assert.equal(samples.count, Math.min(index + 1, window));
      assert.equal(samples.full, index >= window - 1);
      assert.ok(Math.abs(samples.mean - bruteForceMean(values, index, window)) <= 1e-9);
    }
  },
);

await test('a peak tracker ignores partial windows and never forgets the best one', { timeout: 10_000 }, () => {
  const five = new PeakTracker(5);

  for (const value of repeated(0, 4)) {
    five.push(value);
  }

  assert.equal(five.peak, null);
  assert.equal(five.current, null);

  for (const value of [...repeated(0, 1), ...repeated(300, 5), ...repeated(0, 10)]) {
    five.push(value);
  }

  assert.equal(five.peak, 300);
  assert.equal(five.current, 0);

  const ten = new PeakTracker(10);

  for (const value of [...repeated(0, 10), ...repeated(300, 5), ...repeated(0, 10)]) {
    ten.push(value);
  }

  assert.equal(ten.peak, 150);

  ten.reset();
  assert.equal(ten.peak, null);
  assert.equal(ten.current, null);
});

await test(
  'normalized power waits for a full 30 second window and matches the textbook loop',
  { timeout: 10_000 },
  () => {
    const steady = new NormalizedPower();

    for (let second = 0; second < 100; second += 1) {
      steady.push(200);
    }

    assert.ok(Math.abs(steady.value - 200) <= 1e-9);

    const early = new NormalizedPower();

    for (let second = 0; second < window - 1; second += 1) {
      early.push(400);
      assert.equal(early.value, 0);
    }

    early.push(400);
    assert.ok(Math.abs(early.value - 400) <= 1e-9);

    const values = powers();
    const rolling = new NormalizedPower();

    for (const value of values) {
      rolling.push(value);
    }

    assert.ok(Math.abs(rolling.value - bruteForceNormalizedPower(values)) <= 1e-9);
  },
);

await test(
  'normalized power of an alternating ride sits between its average power and its peak power',
  { timeout: 10_000 },
  () => {
    const seconds = new NormalizedPower();

    for (let second = 0; second < 120; second += 1) {
      seconds.push(second % 2 === 0 ? 0 : 400);
    }

    assert.ok(seconds.value >= 200);
    assert.ok(seconds.value <= 400);

    const blocks = new NormalizedPower();

    for (let second = 0; second < 120; second += 1) {
      blocks.push(second % 20 < 10 ? 0 : 400);
    }

    assert.ok(blocks.value > 200);
    assert.ok(blocks.value < 400);
  },
);

await test('a reset makes every counter behave like a new one', { timeout: 10_000 }, () => {
  const samples = new RollingWindow(4);
  const peak = new PeakTracker(3);
  const power = new NormalizedPower();

  for (const value of [100, 200, 300, 400]) {
    samples.push(value);
    peak.push(value);
    power.push(value);
  }

  assert.ok(peak.peak !== null);

  samples.reset();
  peak.reset();
  power.reset();

  assert.equal(samples.count, 0);
  assert.equal(samples.mean, 0);
  assert.equal(peak.peak, null);
  assert.equal(peak.current, null);
  assert.equal(power.value, 0);

  samples.push(5);
  assert.equal(samples.mean, 5);

  peak.push(5);
  assert.equal(peak.current, null);

  for (let second = 0; second < window; second += 1) {
    power.push(50);
  }

  assert.ok(Math.abs(power.value - 50) <= 1e-9);
});

await test('WindowedNormalizedPower: constant power gives that power once the window is full, null before', () => {
  const full = new WindowedNormalizedPower(60);

  for (let second = 0; second < 90; second += 1) {
    full.push(200);
  }

  assert.ok(Math.abs((full.current ?? 0) - 200) < 1e-6);

  const early = new WindowedNormalizedPower(60);

  for (let second = 0; second < 40; second += 1) {
    early.push(200);
  }

  assert.equal(early.current, null);
});
