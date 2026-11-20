import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeStreams } from '#src/world/climb-streams';

await test('basic 1000 m climb at 5 %', () => {
  const distance = Array.from({ length: 11 }, (_, i) => i * 100);
  const altitude = Array.from({ length: 11 }, (_, i) => i * 5);

  const profile = summarizeStreams(distance, altitude);

  assert.ok(profile);
  assert.strictEqual(profile.distanceM, 1000);
  assert.strictEqual(profile.avgGradePct, 5);
  assert.strictEqual(profile.maxGradePct, 5);
  assert.strictEqual(profile.elevationLowM, 0);
  assert.strictEqual(profile.elevationHighM, 50);
  assert.strictEqual(profile.category, null);
  assert.strictEqual(profile.points.length, 11);
  assert.deepStrictEqual(profile.points[0], [0, 0]);
  assert.deepStrictEqual(profile.points[10], [1000, 50]);
});

await test('steep 100 m window gives maxGradePct 12', () => {
  const distance = Array.from({ length: 11 }, (_, i) => i * 100);
  const altitude = [0, 2, 4, 6, 8, 10, 12, 14, 16, 28, 30];

  const profile = summarizeStreams(distance, altitude);

  assert.ok(profile);
  assert.strictEqual(profile.maxGradePct, 12);
});

await test('1000 samples with maxPoints 60 keeps first and last', () => {
  const distance = Array.from({ length: 1000 }, (_, i) => i * 10);
  const altitude = Array.from({ length: 1000 }, (_, i) => i * 0.5);

  const profile = summarizeStreams(distance, altitude, 60);

  assert.ok(profile);
  assert.ok(profile.points.length <= 60);
  assert.deepStrictEqual(profile.points[0], [0, 0]);
  assert.deepStrictEqual(profile.points.at(-1), [9990, 499.5]);
});

await test('mismatched lengths returns null', () => {
  const result = summarizeStreams([0, 100, 200], [0, 5]);

  assert.strictEqual(result, null);
});

await test('single sample returns null', () => {
  const result = summarizeStreams([0], [10]);

  assert.strictEqual(result, null);
});

await test('all-equal distances returns null', () => {
  const result = summarizeStreams([500, 500, 500], [10, 20, 30]);

  assert.strictEqual(result, null);
});

await test('NaN altitude returns null', () => {
  const result = summarizeStreams([0, 100, 200], [0, NaN, 10]);

  assert.strictEqual(result, null);
});

await test('descent gives negative avgGradePct and maxGradePct 0', () => {
  const distance = Array.from({ length: 11 }, (_, i) => i * 100);
  const altitude = Array.from({ length: 11 }, (_, i) => 50 - i * 5);

  const profile = summarizeStreams(distance, altitude);

  assert.ok(profile);
  assert.strictEqual(profile.avgGradePct, -5);
  assert.strictEqual(profile.maxGradePct, 0);
});

await test('20 km at 8 % is HC', () => {
  const distance = Array.from({ length: 201 }, (_, i) => i * 100);
  const altitude = Array.from({ length: 201 }, (_, i) => i * 8);

  const profile = summarizeStreams(distance, altitude);

  assert.ok(profile);
  assert.strictEqual(profile.distanceM, 20_000);
  assert.strictEqual(profile.avgGradePct, 8);
  assert.strictEqual(profile.category, 'HC');
});
