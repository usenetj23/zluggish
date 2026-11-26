import { RateLimit } from '#src/world/rate-limit';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('the rate limit lets 5 actions through and refuses the 6th', { timeout: 10_000 }, () => {
  const now = 1000;
  const limit = new RateLimit(5, 10_000, () => now);

  for (const _attempt of Array.from({ length: 5 }, (_, index) => index)) {
    assert.equal(limit.allow(1), true);
  }

  assert.equal(limit.allow(1), false);
});

await test('the rate limit tracks riders independently', { timeout: 10_000 }, () => {
  const now = 0;
  const limit = new RateLimit(5, 10_000, () => now);

  for (const _attempt of Array.from({ length: 5 }, (_, index) => index)) {
    assert.equal(limit.allow(1), true);
  }

  assert.equal(limit.allow(1), false);
  assert.equal(limit.allow(2), true);
});

await test('the rate limit allows again once the window has passed', { timeout: 10_000 }, () => {
  let now = 0;
  const limit = new RateLimit(5, 10_000, () => now);

  for (const _attempt of Array.from({ length: 5 }, (_, index) => index)) {
    assert.equal(limit.allow(1), true);
  }

  now = 10_000;

  assert.equal(limit.allow(1), true);
});

await test('a refused attempt does not extend the window', { timeout: 10_000 }, () => {
  let now = 0;
  const limit = new RateLimit(5, 10_000, () => now);

  for (const _attempt of Array.from({ length: 5 }, (_, index) => index)) {
    assert.equal(limit.allow(1), true);
  }

  now = 9000;
  assert.equal(limit.allow(1), false);

  now = 10_000;

  assert.equal(limit.allow(1), true);
});

await test('the rate limit forgets riders once their window has expired', { timeout: 10_000 }, () => {
  let now = 0;
  const limit = new RateLimit(5, 10_000, () => now);

  assert.equal(limit.allow(1), true);
  assert.equal(limit.allow(2), true);

  assert.equal(limit.size, 2);

  now = 10_000;
  assert.equal(limit.allow(1), true);

  assert.equal(limit.size, 1);
});
