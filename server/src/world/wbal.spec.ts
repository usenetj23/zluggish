import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultWPrime, WPrimeBalance, wPrimeStep } from '#src/world/wbal';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

/** A deterministic stand-in for randomness: every second gets its own wattage out of this generator. */
const powerAt = (second: number): number => ((second * 137) % 500) + 50;

await test('a second exactly at critical power changes nothing', () => {
  assert.equal(wPrimeStep(15_000, 250, 250, 20_000), 15_000);
  assert.equal(wPrimeStep(20_000, 300, 300, 20_000), 20_000);
});

await test('a second above critical power subtracts exactly its surplus', () => {
  assert.equal(wPrimeStep(15_000, 400, 250, 20_000), 15_000 - 150);
  assert.equal(wPrimeStep(1000, 251, 250, 20_000), 999);
});

await test('recovery below critical power is proportional to the deficit', () => {
  // cp 250, wPrime 1000, balance 500, power 150: 500 + (250 - 150) * (1000 - 500) / 1000 = 550.
  assert.equal(wPrimeStep(500, 150, 250, 1000), 550);
  // A full balance recovers nothing, however soft the second is.
  assert.equal(wPrimeStep(1000, 0, 250, 1000), 1000);
});

await test('the balance is capped at the capacity', () => {
  assert.equal(wPrimeStep(20_000, 0, 250, 20_000), 20_000);
  // 19_990 + 250 * (20_000 - 19_990) / 20_000 = 19_990.125, still under the cap.
  assert.equal(wPrimeStep(19_990, 0, 250, 20_000), 19_990.125);
  // From a balance above the cap the recovery formula dips below it, but the cap still holds.
  assert.equal(wPrimeStep(25_000, 0, 250, 20_000), 20_000);
});

await test('a hard second may drive the balance below zero', () => {
  assert.equal(wPrimeStep(100, 600, 250, 20_000), 100 - 350);
  assert.ok(wPrimeStep(0, 1000, 250, 20_000) < 0);
});

await test('a fresh balance is the full capacity for any usable cp and wPrime', () => {
  const balance = new WPrimeBalance();

  assert.equal(balance.length, 0);
  assert.equal(balance.value(250, 20_000), 20_000);
  assert.equal(balance.value(1, 1), 1);
});

await test('the balance is null for a cp or a wPrime that is no positive finite number', () => {
  const balance = new WPrimeBalance();

  balance.push(300);

  for (const unusable of [0, -5, notANumber, Infinity]) {
    assert.equal(balance.value(unusable, 20_000), null);
    assert.equal(balance.value(250, unusable), null);
  }

  assert.equal(balance.value(250, 20_000), 20_000 - 50);
});

await test('a pushed second is applied once, however often the value is asked', () => {
  const balance = new WPrimeBalance();

  balance.push(400);

  assert.equal(balance.value(250, 20_000), 19_850);
  assert.equal(balance.value(250, 20_000), 19_850);
  assert.equal(balance.length, 1);
});

await test('incremental answers equal a single replay of the same seconds', () => {
  const incremental = new WPrimeBalance();
  const seconds = 600;

  let seen = 0;

  for (const chunk of [7, 60, 1, 240, 292]) {
    for (let pushed = 0; pushed < chunk; pushed += 1) {
      incremental.push(powerAt(seen));
      seen += 1;
    }

    const replayed = new WPrimeBalance();

    for (let second = 0; second < seen; second += 1) {
      replayed.push(powerAt(second));
    }

    assert.equal(incremental.value(230, defaultWPrime), replayed.value(230, defaultWPrime));
  }

  assert.equal(seen, seconds);
  assert.equal(incremental.length, seconds);
});

await test('an FTP edited mid-ride replays the ride and matches a fresh instance', () => {
  const balance = new WPrimeBalance();

  for (let second = 0; second < 120; second += 1) {
    balance.push(powerAt(second));
  }

  assert.equal(balance.value(250, defaultWPrime), balance.value(250, defaultWPrime));

  const withOtherFtp = new WPrimeBalance();

  for (let second = 0; second < 120; second += 1) {
    withOtherFtp.push(powerAt(second));
  }

  const edited = balance.value(310, defaultWPrime);

  assert.equal(edited, withOtherFtp.value(310, defaultWPrime));
  assert.notEqual(edited, withOtherFtp.value(250, defaultWPrime));

  for (let second = 120; second < 150; second += 1) {
    balance.push(powerAt(second));
    withOtherFtp.push(powerAt(second));
  }

  assert.equal(balance.value(310, defaultWPrime), withOtherFtp.value(310, defaultWPrime));
});

await test('a reset restarts the ride from a full capacity', () => {
  const balance = new WPrimeBalance();

  balance.push(600);
  balance.push(600);

  assert.equal(balance.length, 2);
  assert.ok(balance.value(250, 20_000) !== null && (balance.value(250, 20_000) ?? 0) < 20_000);

  balance.reset();

  assert.equal(balance.length, 0);
  assert.equal(balance.value(250, 20_000), 20_000);

  balance.push(600);

  assert.equal(balance.value(250, 20_000), 20_000 - 350);
});

await test('an unreadable wattage counts as zero and recovers like coasting', () => {
  const balance = new WPrimeBalance();
  const coasting = new WPrimeBalance();

  for (const value of [notANumber, -42, Infinity, undefined, null]) {
    // SAFETY: a caller outside TypeScript may hand anything over; the balance must stay finite.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    balance.push(value as number);
    coasting.push(0);
  }

  assert.equal(balance.length, 5);
  assert.equal(balance.value(250, 20_000), coasting.value(250, 20_000));
});
