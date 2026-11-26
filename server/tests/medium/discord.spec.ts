import { Effect, Layer } from 'effect';
import { validateConfig } from '#src/config/index';
import { DiscordService } from '#src/services/discord.service';
import { ChatService } from '#src/services/chat-bridge.service';
import { MessageService } from '#src/services/message.service';
import { RuntimeContext } from '#src/context';
import type { RepositoryContext } from '#src/context';
import { SocialPlayerActionSchema } from '#src/protocol/generated/tcp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function discordService(context: RepositoryContext) {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* DiscordService;
    }).pipe(
      Effect.provide(DiscordService.layer),
      Effect.provide(ChatService.layer),
      Effect.provide(MessageService.layer),
      Effect.provide(Layer.succeed(RuntimeContext, context)),
    ),
  );
}

await test('Discord bridges only configured human chat, handles commands and stops after close', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Discord Rider', 'test-password');
  const sent: Array<string> = [];
  const presence: Array<number> = [];
  let closed = false;

  const runtime = {
    ...f,
    config: validateConfig({
      storageDir: f.config.storageDir,
      integrations: { discord: { channel: '42', helpMessage: 'Help text' } },
    }),
  };

  const bridge = Effect.runSync(
    discordService(runtime).bridge({
      send: (content) => {
        sent.push(content);

        return Promise.resolve();
      },
      presence: (count) => {
        presence.push(count);
      },
      close: () => {
        closed = true;

        return Promise.resolve();
      },
    }),
  );

  f.world.online.set(BigInt(user.player_id), create(PlayerStateSchema));
  bridge.receive('99', 'Wrong channel', false, 'ignored');
  bridge.receive('42', 'Bot', true, 'ignored');
  assert.equal(f.world.updates.size, 0);
  bridge.receive('42', 'Friend', false, 'Ride on!');
  const update = f.world.updates.get(BigInt(user.player_id))?.[0];
  assert.ok(update);
  const action = fromBinary(SocialPlayerActionSchema, update.payload);
  assert.equal(action.firstName, 'Friend');
  assert.equal(action.message, 'Ride on!');
  bridge.receive('42', 'Friend', false, '!online');
  bridge.receive('42', 'Friend', false, '!help');
  bridge.receive('42', 'Friend', false, '!ping');
  assert.deepEqual(sent, ['1 riders online', 'Help text', 'pong']);
  bridge.online(BigInt(user.player_id), true);
  assert.deepEqual(presence, [1]);
  await bridge.close();
  bridge.send('after close');
  assert.equal(closed, true);
  assert.equal(sent.length, 3);
});

await test('Discord delivery failure releases capacity for the next message', async (t) => {
  const f = runtimeFixture(t);
  const sent: Array<string> = [];
  let fail = true;

  const bridge = Effect.runSync(
    discordService(f).bridge({
      send: (content) => {
        if (fail) {
          return Promise.reject(new Error('offline'));
        }
        sent.push(content);

        return Promise.resolve();
      },
      presence: () => {},
      close: () => Promise.resolve(),
    }),
  );

  const warnings = t.mock.method(console, 'warn', () => {});
  bridge.send('failed');
  await new Promise<void>((done) => {
    setImmediate(done);
  });
  assert.equal(warnings.mock.callCount(), 1);
  fail = false;
  bridge.send('next');
  await new Promise<void>((done) => {
    setImmediate(done);
  });
  assert.deepEqual(sent, ['next']);
  await bridge.close();
});
