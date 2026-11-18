import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { Random } from '#src/world/geometry';
import { JokeTeller, chatUpdate, loadJokes, resolveLanguage } from '#src/world/jokes';
import { fromBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets', import.meta.url));

const pool = new Map([
  ['en', ['one', 'two', 'three', 'four', 'five']],
  ['pl', ['raz']],
]);

await test('the bundled jokes cover English and Polish with no blank entries', () => {
  const jokes = loadJokes(assets);

  for (const language of ['en', 'pl']) {
    const list = jokes.get(language) ?? [];
    assert.ok(list.length >= 10, `${language} has jokes`);
    assert.ok(
      list.every((joke) => joke === joke.trim() && joke.length > 0),
      `${language} jokes are trimmed`,
    );
  }
});

await test('loading jokes lowercases languages and drops blank jokes and empty languages', (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), 'jokes-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(resolve(folder, 'data'));
  writeFileSync(
    resolve(folder, 'data/jokes.txt'),
    JSON.stringify({ EN: [' a ', '', ' '.repeat(3), 'b'], de: [' '.repeat(2)], pl: [] }),
  );

  assert.deepEqual([...loadJokes(folder)], [['en', ['a', 'b']]]);
});

await test('the joke language follows the flag, a named language, or falls back to English', () => {
  assert.equal(resolveLanguage('auto', 616, pool), 'pl');
  assert.equal(resolveLanguage('auto', 0, pool), 'en');
  assert.equal(resolveLanguage('auto', 840, pool), 'en');
  assert.equal(resolveLanguage('PL', 0, pool), 'pl');
  assert.equal(resolveLanguage('de', 616, pool), 'en');
  assert.equal(resolveLanguage('auto', 616, new Map([['en', ['one']]])), 'en');
});

await test('the next joke comes after the interval times 0.5 to 1.5, and never when the interval is 0', () => {
  for (const seed of [1, 7, 99, 12_345]) {
    const teller = new JokeTeller(new Random(seed), pool, 100, 1000);

    assert.equal(teller.due(1049), false);
    assert.equal(teller.due(1150), true);
  }

  const off = new JokeTeller(new Random(1), pool, 0, 0);

  assert.equal(off.due(1_000_000), false);
  assert.equal(off.poll(1_000_000, 'en'), null);
});

await test('jokes do not repeat until the list has been told, and a round never starts with the last joke', () => {
  const teller = new JokeTeller(new Random(42), pool, 100, 0);
  let now = 0;

  const told = Array.from({ length: 20 }, () => {
    now += 150;

    return teller.poll(now, 'en');
  });

  for (let round = 0; round < 4; round++)
    assert.equal(new Set(told.slice(round * 5, round * 5 + 5)).size, 5, `round ${round} tells every joke once`);

  for (let index = 5; index < told.length; index += 5) assert.notEqual(told[index], told[index - 1]);
});

await test('polling waits for the interval, skips unknown languages without using it up, and reset postpones', () => {
  const teller = new JokeTeller(new Random(3), pool, 100, 0);

  assert.equal(teller.poll(10, 'en'), null);
  assert.equal(teller.poll(200, 'de'), null);
  assert.equal(teller.due(200), true);
  assert.equal(teller.poll(200, 'pl'), 'raz');
  assert.equal(teller.due(200), false);

  teller.reset(1000);

  assert.equal(teller.due(1049), false);
  assert.equal(teller.due(1150), true);
});

await test('a joke is sent as a public chat text message under the rider name', () => {
  const update = chatUpdate('Why did the cyclist...', 'Tom', 'Smith', 5000n);
  const chat = fromBinary(SocialPlayerActionSchema, update.payload);

  assert.equal(update.waType, WA_TYPE.WAT_SPA);
  assert.equal(update.worldTimeBorn, 5000n);
  assert.equal(update.worldTimeExpire, 65_000n);
  assert.equal(chat.spaType, SocialPlayerActionType.SOCIAL_TEXT_MESSAGE);
  assert.equal(chat.toPlayerId, 0n);
  assert.deepEqual([chat.firstName, chat.lastName, chat.message], ['Tom', 'Smith', 'Why did the cyclist...']);
});
