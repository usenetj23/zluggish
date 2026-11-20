import assert from 'node:assert/strict';
import { test } from 'node:test';
import { powerRatio, rampProgress, stepStarts } from '#src/world/narration';

const block = (durationSeconds: number | null, low: number, high = low) => ({
  name: 'Block',
  durationSeconds,
  meters: null,
  power: { format: 'ftp' as const, low, high },
  cadence: null,
});

await test('every block starts where the one before it ends', () => {
  assert.deepEqual(
    stepStarts([block(180, 70, 88), block(20, 100), block(null, 70), block(40, 70)]),
    [0, 180, 200, 200],
  );
  assert.deepEqual(stepStarts([]), []);
});

await test('a ramp is read along its length and a flat block everywhere the same', () => {
  const warmup = block(180, 70, 88);

  assert.equal(powerRatio(warmup, 0), 0.7);
  assert.equal(powerRatio(warmup, 90), 0.79);
  assert.equal(powerRatio(warmup, 180), 0.88);
  assert.equal(powerRatio(warmup, 500), 0.88);
  assert.equal(powerRatio(block(30, 100), 12), 1);
});

await test('only a target in percent of FTP has a ratio', () => {
  assert.equal(powerRatio({ ...block(60, 100), power: { format: 'watts', low: 200, high: 200 } }, 10), null);
  assert.equal(powerRatio({ ...block(60, 100), power: null }, 10), null);
});

await test('the watts on the screen say how far along a ramp the workout is', () => {
  const warmup = block(180, 70, 88);

  assert.equal(rampProgress(warmup, 300, 210), 0); // 70 % of 300 W: the start
  assert.equal(rampProgress(warmup, 300, 237), 90); // 79 %: half way
  assert.equal(rampProgress(warmup, 300, 264), 180); // 88 %: the end
});

await test('a block that is not a ramp, an unknown FTP and a target outside the ramp say nothing', () => {
  const warmup = block(180, 70, 88);

  assert.equal(rampProgress(block(30, 100), 300, 300), null);
  assert.equal(rampProgress(warmup, 0, 237), null);
  assert.equal(rampProgress(warmup, 300, 350), null);
  assert.equal(rampProgress(warmup, 300, 100), null);
  assert.equal(rampProgress(block(0, 70, 88), 300, 237), null);
});
