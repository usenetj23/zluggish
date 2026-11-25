import { ChatLog } from '#src/world/chat-log';
import type { ChatMessage } from '#src/world/chat-log';
import { World, worldTime } from '#src/world/state';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** A public chat bubble as the game's world update carries it. */
const chatUpdate = (text: string, firstName: string, lastName: string, time: bigint) =>
  create(WorldAttributeSchema, {
    serverRealm: 1n,
    waType: WA_TYPE.WAT_SPA,
    worldTimeBorn: time,
    worldTimeExpire: time + 60_000n,
    payload: toBinary(
      SocialPlayerActionSchema,
      create(SocialPlayerActionSchema, {
        playerId: 0n,
        toPlayerId: 0n,
        spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
        firstName,
        lastName,
        message: text,
        countryCode: 0,
      }),
    ),
  });

/** A chat message with everything a test does not care about filled in. */
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  from: 1,
  to: 0,
  message: 'hello',
  ts: 1000,
  firstName: 'Bob',
  lastName: 'Fast',
  avatar: '',
  team: null,
  muted: false,
  ...over,
});

await test('history is newest first and honours the limit', { timeout: 10_000 }, () => {
  const log = new ChatLog();

  for (const text of ['first', 'second', 'third']) {
    log.record(message({ message: text, ts: 1000 + text.length }));
  }

  const history = log.history(1);

  assert.deepEqual(
    history.map((entry) => entry.message),
    ['third', 'second', 'first'],
  );
  assert.deepEqual(
    log.history(1, 2).map((entry) => entry.message),
    ['third', 'second'],
  );
  assert.deepEqual(log.history(1, 0), []);
});

await test('capacity drops the oldest messages', { timeout: 10_000 }, () => {
  const log = new ChatLog(2);

  for (const text of ['one', 'two', 'three']) {
    log.record(message({ message: text }));
  }

  assert.deepEqual(
    log.history(1).map((entry) => entry.message),
    ['three', 'two'],
  );
});

await test('a public message is visible to every viewer', { timeout: 10_000 }, () => {
  const log = new ChatLog();

  log.record(message({ from: 1, to: 0, message: 'public' }));

  for (const viewer of [1, 2, 99]) {
    assert.equal(log.history(viewer).length, 1);
  }
});

await test('a direct message is visible to its sender and recipient only', { timeout: 10_000 }, () => {
  const log = new ChatLog();

  log.record(message({ from: 5, to: 7, message: 'psst' }));

  assert.equal(log.history(5).length, 1);
  assert.equal(log.history(7).length, 1);
  assert.deepEqual(log.history(9), []);

  const seen = new Map<number, Array<string>>([
    [5, []],
    [7, []],
    [9, []],
  ]);

  for (const viewer of seen.keys()) {
    log.listen(viewer, (entry) => {
      seen.get(viewer)?.push(entry.message);
    });
  }
  log.record(message({ from: 5, to: 7, message: 'again' }));

  assert.deepEqual(seen.get(5), ['again']);
  assert.deepEqual(seen.get(7), ['again']);
  assert.deepEqual(seen.get(9), []);
});

await test('a listener sees only its messages and the disposer stops it twice', { timeout: 10_000 }, () => {
  const log = new ChatLog();
  const seen: Array<string> = [];

  const dispose = log.listen(3, (entry) => {
    seen.push(entry.message);
  });

  log.record(message({ from: 1, to: 2, message: 'not mine' }));
  log.record(message({ from: 1, to: 0, message: 'public' }));
  log.record(message({ from: 1, to: 3, message: 'to me' }));

  assert.deepEqual(seen, ['public', 'to me']);

  dispose();
  dispose();
  log.record(message({ from: 1, to: 0, message: 'after' }));

  assert.deepEqual(seen, ['public', 'to me']);
});

await test('a throwing listener does not stop the others and reports its error', { timeout: 10_000 }, () => {
  const errors: Array<unknown> = [];
  const log = new ChatLog(200, (error) => {
    errors.push(error);
  });
  const seen: Array<string> = [];

  log.listen(1, () => {
    throw new Error('boom');
  });
  log.listen(1, (entry) => {
    seen.push(entry.message);
  });

  assert.doesNotThrow(() => log.record(message({ from: 1, to: 0, message: 'hello' })));

  assert.deepEqual(seen, ['hello']);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal(errors[0].message, 'boom');
});

await test('a listener that disposes itself during delivery is safe', { timeout: 10_000 }, () => {
  const log = new ChatLog();
  const seen: Array<string> = [];

  const dispose = log.listen(1, (entry) => {
    seen.push('once');
    dispose();
    log.record(message({ from: 1, to: 0, message: `${entry.message} nested` }));
  });

  log.record(message({ from: 1, to: 0, message: 'hello' }));

  assert.equal(log.history(1).length, 2);
});

await test('history returns copies, so mutating a result changes nothing', { timeout: 10_000 }, () => {
  const log = new ChatLog();

  log.record(message({ message: 'hello' }));

  const history = log.history(1);

  history[0]!.message = 'mutated';
  history.length = 0;

  assert.deepEqual(
    log.history(1).map((entry) => entry.message),
    ['hello'],
  );
});

await test('the world records a public chat bubble from an enqueued update', { timeout: 10_000 }, () => {
  const world = new World();

  world.enqueue(chatUpdate('hello', 'Bob', 'Fast', worldTime()), [1n, 2n]);

  const history = world.chat.history(1);

  assert.equal(history.length, 1);
  assert.equal(history[0]!.message, 'hello');
  assert.equal(history[0]!.firstName, 'Bob');
  assert.equal(history[0]!.lastName, 'Fast');
  assert.equal(history[0]!.to, 0);
  assert.equal(history[0]!.avatar, '');
});

await test('an update that is not a social action records nothing', { timeout: 10_000 }, () => {
  const world = new World();

  world.enqueue(
    create(WorldAttributeSchema, {
      serverRealm: 1n,
      waType: WA_TYPE.WAT_LEAVE,
      worldTimeBorn: worldTime(),
      worldTimeExpire: worldTime() + 60_000n,
      payload: new Uint8Array(),
    }),
    [1n, 2n],
  );

  assert.deepEqual(world.chat.history(1), []);
});

await test(
  'a direct message enqueued into the world is visible to sender and recipient only',
  { timeout: 10_000 },
  () => {
    const world = new World();

    const action = create(SocialPlayerActionSchema, {
      playerId: 5n,
      toPlayerId: 7n,
      spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
      message: 'psst',
      firstName: 'A',
      lastName: 'B',
    });

    world.enqueue(
      create(WorldAttributeSchema, {
        serverRealm: 1n,
        waType: WA_TYPE.WAT_SPA,
        worldTimeBorn: worldTime(),
        worldTimeExpire: worldTime() + 60_000n,
        payload: toBinary(SocialPlayerActionSchema, action),
      }),
      [5n, 7n],
    );

    assert.equal(world.chat.history(5).length, 1);
    assert.equal(world.chat.history(7).length, 1);
    assert.deepEqual(world.chat.history(9), []);
  },
);

await test(
  'a bot message enqueued with a speaker is logged under the speaker, not the wire id',
  { timeout: 10_000 },
  () => {
    const world = new World();

    world.enqueue(chatUpdate('a bot joke', 'Bot', 'Rider', worldTime()), [1n], 8_000_005n);

    const history = world.chat.history(1);

    assert.equal(history.length, 1);
    assert.equal(history[0]!.from, 8_000_005);

    const queued = [...(world.updates.get(1n) ?? [])];

    assert.equal(queued.length, 1);

    const action = fromBinary(SocialPlayerActionSchema, queued[0]!.payload);

    assert.equal(action.playerId, 0n);
  },
);

await test('two speakers in a row are two log entries with different senders', { timeout: 10_000 }, () => {
  const world = new World();

  world.enqueue(chatUpdate('first', 'A', 'One', worldTime()), [1n], 8_000_005n);
  world.enqueue(chatUpdate('second', 'B', 'Two', worldTime()), [1n], 8_000_006n);

  const history = world.chat.history(1);

  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((entry) => entry.from),
    [8_000_006, 8_000_005],
  );
});

await test('without a speaker the log still records the action player id', { timeout: 10_000 }, () => {
  const world = new World();

  world.enqueue(chatUpdate('from a rider', 'Bob', 'Fast', worldTime()), [1n]);

  const queued = [...(world.updates.get(1n) ?? [])];
  const history = world.chat.history(1);

  assert.equal(history.length, 1);
  assert.equal(history[0]!.from, Number(fromBinary(SocialPlayerActionSchema, queued[0]!.payload).playerId));
});
