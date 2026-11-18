import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { GhostSchema, PlayerStateSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { worldTime } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('simulation playback stops, resumes and removes deleted pacers on reload', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 12) });
  const f = runtimeFixture(t);
  const folder = resolve(f.accounts.storage, 'robopacers/demo');
  new AssetFiles().writeDurable(
    resolve(folder, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, firstName: 'Pacer' })),
  );
  new AssetFiles().writeDurable(
    resolve(folder, 'route.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, {
        playerId: 100,
        states: [0, 1000, 2000].map((x) => create(PlayerStateSchema, { id: 100n, x, roadTime: x + 1 })),
      }),
    ),
  );
  const simulation = new Simulation(f, () => Date.now() / 1000);
  t.after(() => simulation.close());
  await simulation.ready;
  const first = f.world.synthetic.get(100n)?.x;
  assert.ok(first !== undefined);
  simulation.start();
  simulation.start();
  t.mock.timers.tick(1000);
  const moved = f.world.synthetic.get(100n)?.x;
  assert.notEqual(moved, first);
  await simulation.close();
  t.mock.timers.tick(1000);
  assert.equal(f.world.synthetic.get(100n)?.x, moved);
  simulation.start();
  t.mock.timers.tick(1000);
  assert.notEqual(f.world.synthetic.get(100n)?.x, moved);
  rmSync(folder, { recursive: true });
  await simulation.reload();
  assert.equal(f.world.synthetic.has(100n), false);
  assert.equal(f.profiles.synthetic.has(100n), false);
});

await test('ghost regroup before lazy loading preserves independent playback and loading states', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Ghost Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
  const id = BigInt(rider.player_id);

  const state = create(PlayerStateSchema, {
    id,
    f19: (6 << 16) | 4,
    aux3: 1 << 8,
    roadTime: 1000,
    worldTime: worldTime(),
  });

  f.world.receive(id, state);
  simulation.regroup(id);
  assert.equal(simulation.ghosts.get(id)?.loading, 'waiting');
  assert.equal(simulation.ghosts.get(id)?.playback, 'playing');
  const file = resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/test.bin');
  new AssetFiles().writeDurable(
    file,
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state] })),
  );
  f.world.receive(id, { ...state, roadTime: 2000, worldTime: state.worldTime + 1n });
  assert.equal(simulation.ghosts.get(id)?.loading, 'loading');
  await simulation.idle();
  assert.equal(simulation.ghosts.get(id)?.loading, 'loaded');
  now += 3;
  simulation.tick();
  const ghostId = id + 10_000_000n;
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), false);
  f.world.receive(id, { ...state, roadTime: 500, worldTime: state.worldTime + 2n });
  simulation.regroup(id);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  f.world.logout(id);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(f.world.personal.has(id), false);
});

await test('riding, ghost and bookmark loads, blobs, recovery and logout make no synchronous file calls', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Async Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  const id = BigInt(rider.player_id);

  const state = (index: number) =>
    create(PlayerStateSchema, {
      id,
      f19: (6 << 16) | 4,
      aux3: 1 << 8,
      roadTime: 1000 + index,
      worldTime: worldTime() + BigInt(index) * 3000n,
    });

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/old.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state(0), state(1)] })),
  );
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
  f.services.recovery.start();
  t.after(() => f.services.recovery.close());

  // From here on every synchronous file call throws and is recorded.
  const calls: string[] = [];

  const names = [
    'readFileSync',
    'readdirSync',
    'existsSync',
    'statSync',
    'lstatSync',
    'openSync',
    'writeFileSync',
    'appendFileSync',
    'fsyncSync',
    'renameSync',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'linkSync',
    'copyFileSync',
  ] as const;

  const mocks = names.map((name) =>
    t.mock.method(fs, name, () => {
      calls.push(name);
      throw new Error(`${name} on the riding path`);
    }),
  );

  syncBuiltinESMExports();

  try {
    f.world.login(id, new Uint8Array(16));

    for (let index = 0; index < 6; index++) {
      now++;
      f.world.receive(id, state(index));
      simulation.tick();
    }

    assert.equal(simulation.command(id, 'blob 4'), 'Blob settings saved.');
    simulation.command(id, 'bookmark Home');
    await simulation.loadBookmarks(id);
    await f.services.recovery.checkpoint();
    await simulation.idle();
    f.world.logout(id);
    await simulation.idle();
    await f.services.recovery.recordings.idle();
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(calls, []);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(simulation.bookmarks.get(id)?.size, 2, 'the command bookmark and the last ride bookmark');
});

await test('the blob rider furthest ahead tells a joke in the chat, but only while the rider is riding', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Joke Rider', 'test-password');
  const id = BigInt(rider.player_id);
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
  f.settings.saveWorld(`blob:${id}`, { enabled: true, riders: 8, jokes: true, jokeInterval: 10 });
  simulation.loadBlob(id);
  f.world.login(id, new Uint8Array(16));
  const sent = t.mock.method(f.world, 'enqueue');

  const jokes = () =>
    sent.mock.calls
      .map((call) => call.arguments[0])
      .filter((update) => update.waType === WA_TYPE.WAT_SPA)
      .map((update) => fromBinary(SocialPlayerActionSchema, update.payload));

  const ride = (age: bigint) => {
    for (let index = 0; index < 60; index++) {
      now++;
      f.world.receive(
        id,
        create(PlayerStateSchema, {
          id,
          f19: (6 << 16) | 4,
          aux3: 1 << 8,
          roadTime: 1_000_000 + now * 10,
          worldTime: worldTime() - age,
        }),
      );
      simulation.tick();
    }
  };

  // The last packet is 30 s old: nobody is riding, so nothing is said however long it lasts.
  ride(30_000n);
  assert.deepEqual(jokes(), []);

  ride(0n);
  const told = jokes();
  const names = new Set(simulation.blobs.get(id)?.riders.map((blobRider) => blobRider.profile.firstName));
  assert.ok(told.length > 0, 'a joke was told while riding');
  assert.ok(told.length <= 8, 'jokes are spaced by the interval');

  for (const chat of told) {
    assert.equal(chat.spaType, SocialPlayerActionType.SOCIAL_TEXT_MESSAGE);
    assert.ok(simulation.jokes.get('en')?.includes(chat.message), 'the text is one of the jokes');
    assert.ok(names.has(chat.firstName), 'it is said under the name of a blob rider');
  }

  assert.ok(
    sent.mock.calls.every((call) => call.arguments[1] === undefined || call.arguments[1]?.every((to) => to === id)),
    'only the rider that the blob rides with hears it',
  );
});
