import { countryNumeric, countryNumericByAlpha2 } from '#src/world/country-codes';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('a known alpha-2 code becomes its numeric code', { timeout: 10_000 }, () => {
  assert.equal(countryNumeric('pl'), 616);
  assert.equal(countryNumeric('gb'), 826);
});

await test('case and surrounding spaces are ignored', { timeout: 10_000 }, () => {
  assert.equal(countryNumeric('PL'), 616);
  assert.equal(countryNumeric('PL '), 616);
  assert.equal(countryNumeric(' pl'), 616);
});

await test('an unknown code becomes null', { timeout: 10_000 }, () => {
  assert.equal(countryNumeric('xx'), null);
  assert.equal(countryNumeric(''), null);
  assert.equal(countryNumeric('Polska'), null);
});

await test('a non-string becomes null', { timeout: 10_000 }, () => {
  assert.equal(countryNumeric(616), null);
  assert.equal(countryNumeric(null), null);
  assert.equal(countryNumeric(undefined), null);
});

await test('every table value is a positive integer', { timeout: 10_000 }, () => {
  for (const value of countryNumericByAlpha2.values()) {
    assert.ok(Number.isSafeInteger(value));
    assert.ok(value > 0);
  }
});
