import { proCyclingStatsUrl } from '#src/world/pro-cycling-stats';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('a bot name with an accent and a team suffix slugs to the ProCyclingStats rider path', () => {
  assert.equal(
    proCyclingStatsUrl('Benoît', 'Cosnefroy (UAD)'),
    'https://www.procyclingstats.com/rider/benoit-cosnefroy',
  );
});

await test('diacritics decompose to plain ASCII letters', () => {
  assert.equal(proCyclingStatsUrl('Matej', 'Mohorič'), 'https://www.procyclingstats.com/rider/matej-mohoric');
  assert.equal(proCyclingStatsUrl('Kévin', 'Vauquelin (IGD)'), 'https://www.procyclingstats.com/rider/kevin-vauquelin');
  assert.equal(
    proCyclingStatsUrl('Einer Augusto', 'Rubio (MOV)'),
    'https://www.procyclingstats.com/rider/einer-augusto-rubio',
  );
  assert.equal(proCyclingStatsUrl('Łukasz', 'Wiśniowski'), 'https://www.procyclingstats.com/rider/lukasz-wisniowski');
});

await test('names that hold nothing but a parenthesis have no slug', () => {
  assert.equal(proCyclingStatsUrl('(UAD)', '(IGD)'), null);
  assert.equal(proCyclingStatsUrl('', ' '.repeat(3)), null);
});

await test('a team prefix in the first name does not leave a leading hyphen', () => {
  assert.equal(proCyclingStatsUrl('(UAD) Ben', 'Healy'), 'https://www.procyclingstats.com/rider/ben-healy');
});

await test('an empty first name does not leave a leading hyphen', () => {
  assert.equal(proCyclingStatsUrl('  ', 'Ayuso'), 'https://www.procyclingstats.com/rider/ayuso');
});

await test('a hostile name stays inside the rider path', () => {
  const url = proCyclingStatsUrl('x/../../evil', 'a=1');

  assert.ok(url === null || /^https:\/\/www\.procyclingstats\.com\/rider\/[a-z0-9-]+$/.test(url), String(url));
});
