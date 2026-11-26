import { validateConfig } from '#src/config/index';
import { MatrixRepository } from '#src/repositories/matrix.repository';
import { MatrixService } from '#src/services/matrix.service';
import { ChatService } from '#src/services/chat-bridge.service';
import { MessageService } from '#src/services/message.service';
import { RuntimeContext } from '#src/context';
import type { RepositoryContext } from '#src/context';
import { SocialPlayerActionSchema } from '#src/protocol/generated/tcp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { create, fromBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Effect, Layer, Schema } from 'effect';

function matrixService(context: RepositoryContext) {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* MatrixService;
    }).pipe(
      Effect.provide(MatrixService.layer),
      Effect.provide(ChatService.layer),
      Effect.provide(MessageService.layer),
      Effect.provide(Layer.succeed(RuntimeContext, context)),
    ),
  );
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await sleep(10);
  }
  assert.ok(condition());
}

const message = (sender: string, body: string, extra = {}) => ({
  type: 'm.room.message',
  sender,
  content: { msgtype: 'm.text', body, ...extra },
});

const join = (name: string) => ({
  type: 'm.room.member',
  sender: name,
  state_key: name,
  content: { membership: 'join', displayname: name === '@alice:test' ? 'Alice' : null },
});

const login = Schema.Struct({
  identifier: Schema.Struct({ type: Schema.String, user: Schema.String }),
  device_id: Schema.optional(Schema.String),
});

type Json = typeof Schema.Json.Type;

interface Homeserver {
  url: string;
  logins: Array<(typeof login)['Type']>;
  sent: Array<string>;
  syncs: Array<URLSearchParams>;
  encrypted: boolean;
}

async function homeserver(t: TestContext) {
  const state: Homeserver = { url: '', logins: [], sent: [], syncs: [], encrypted: false };
  const held: Array<ServerResponse> = [];

  const reply = (response: ServerResponse, status: number, body: Json) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

  const handle = (request: IncomingMessage, response: ServerResponse, body: string) => {
    const url = new URL(request.url ?? '', state.url);
    const path = decodeURIComponent(url.pathname).replace('/_matrix/client/v3', '');
    const authorized = request.headers.authorization === 'Bearer token-1';

    if (path === '/login') {
      state.logins.push(Schema.decodeUnknownSync(login)(JSON.parse(body)));

      return reply(response, 200, { user_id: '@bot:test', device_id: 'DEVICE', access_token: 'token-1' });
    }

    if (!authorized) {
      return reply(response, 401, { errcode: 'M_UNKNOWN_TOKEN' });
    }

    if (path === '/account/whoami') {
      return reply(response, 200, { user_id: '@bot:test' });
    }

    if (path === '/join/#ride:test') {
      return reply(response, 200, { room_id: '!room:test' });
    }

    if (path.startsWith('/presence/')) {
      return reply(response, 200, {});
    }

    if (path.startsWith('/rooms/!room:test/send/m.room.message/')) {
      state.sent.push(Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String }))(JSON.parse(body)).body);

      return reply(response, 200, { event_id: '$sent' });
    }

    if (path === '/sync') {
      state.syncs.push(url.searchParams);
      const since = url.searchParams.get('since');

      if (since === 'second') {
        held.push(response);

        return;
      }

      const events = since
        ? [
            join('@bob:test'),
            message('@alice:test', 'Ride on!'),
            message('@bot:test', 'Echo of my own message'),
            message('@alice:test', '* Ride on!!', { 'm.relates_to': { rel_type: 'm.replace' } }),
            message('@bob:test', '!ping'),
            { type: 'm.reaction', sender: '@bob:test', content: {} },
          ]
        : [message('@alice:test', 'Old history')];

      const roomState = since
        ? []
        : [
            join('@alice:test'),
            ...(state.encrypted
              ? [{ type: 'm.room.encryption', sender: '@alice:test', state_key: '', content: {} }]
              : []),
          ];

      return reply(response, 200, {
        next_batch: since ? 'second' : 'first',
        rooms: { join: { '!room:test': { state: { events: roomState }, timeline: { events } } } },
      });
    }

    reply(response, 404, { errcode: 'M_UNRECOGNIZED' });
  };

  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => handle(request, response, body));
  });

  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(server.address());
  state.url = `http://127.0.0.1:${port}`;

  t.after(async () => {
    for (const response of held) {
      response.destroy();
    }
    server.closeAllConnections();
    await new Promise((done) => {
      server.close(done);
    });
  });

  return state;
}

function storage(t: TestContext, credentials = '[matrix]\npassword = secret\n') {
  const dir = mkdtempSync(resolve(tmpdir(), 'zluggish-matrix-'));
  writeFileSync(resolve(dir, 'matrix.cfg'), credentials);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function open(t: TestContext, server: Homeserver, dir: string) {
  const received: Array<Array<string>> = [];
  const warnings: Array<string> = [];

  const settings = validateConfig({
    storageDir: dir,
    integrations: {
      matrix: {
        enabled: true,
        credentialsFile: resolve(dir, 'matrix.cfg'),
        homeserver: `${server.url}/`,
        user: 'bot',
        room: '#ride:test',
      },
    },
  }).integrations.matrix;

  const transport = new MatrixRepository().openMatrixTransport(settings, dir, {
    receive: (author, content) => {
      received.push([author, content]);
    },
    onlineCount: () => 2,
    encrypted: () => {
      warnings.push('encrypted');
    },
    connectionFailed: () => {
      warnings.push('connection');
    },
    loginFailed: () => {
      warnings.push('login');
    },
  });

  t.after(() => transport.close());

  return { transport, received, warnings };
}

await test('Matrix transport relays new room chat and keeps one device across restarts', async (t) => {
  const server = await homeserver(t);
  const dir = storage(t);
  const first = open(t, server, dir);

  await until(() => server.syncs.length === 3);
  assert.deepEqual(first.received, [
    ['Alice', 'Ride on!'],
    ['bob', '!ping'],
  ]);
  assert.equal(JSON.parse(server.syncs[0]?.get('filter') ?? '').room.rooms[0], '!room:test');
  await first.transport.send('Hello riders');
  assert.deepEqual(server.sent, ['Hello riders']);
  assert.deepEqual(first.warnings, []);
  await first.transport.close();

  const session = resolve(dir, 'matrix-session.json');

  // Windows has no POSIX permission bits to check.
  if (process.platform !== 'win32') {
    assert.equal(statSync(session).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(session, 'utf8')).deviceId, 'DEVICE');
  assert.equal(server.logins.length, 1);
  assert.deepEqual(server.logins[0]?.identifier, { type: 'm.id.user', user: 'bot' });

  const second = open(t, server, dir);
  await until(() => server.syncs.length === 6);
  await second.transport.close();
  assert.equal(server.logins.length, 1);
  await assert.rejects(second.transport.send('after close'), /not connected/);
});

await test('Matrix transport logs in again with the same device when the stored token is revoked', async (t) => {
  const server = await homeserver(t);
  const dir = storage(t);

  writeFileSync(
    resolve(dir, 'matrix-session.json'),
    JSON.stringify({ homeserver: server.url, userId: '@bot:test', deviceId: 'DEVICE', accessToken: 'revoked' }),
  );
  const { transport } = open(t, server, dir);
  await until(() => server.syncs.length === 3);
  await transport.close();
  assert.equal(server.logins[0]?.device_id, 'DEVICE');
  assert.equal(JSON.parse(readFileSync(resolve(dir, 'matrix-session.json'), 'utf8')).accessToken, 'token-1');
});

await test('Matrix transport never posts plain text into an encrypted room', async (t) => {
  const server = await homeserver(t);
  server.encrypted = true;
  const { transport, warnings } = open(t, server, storage(t));

  await until(() => server.syncs.length === 3);
  await assert.rejects(transport.send('secret plans'), /encrypted/);
  await transport.close();
  assert.deepEqual(server.sent, []);
  assert.deepEqual(warnings, ['encrypted']);
});

await test('Matrix transport reports a refused login and stores no session', async (t) => {
  const server = await homeserver(t);
  const dir = storage(t, '[matrix]\naccess_token = wrong\n');
  const { transport, warnings } = open(t, server, dir);

  await until(() => warnings.length > 0);
  await transport.close();
  assert.deepEqual(warnings, ['login']);
  assert.equal(server.logins.length, 0);
  assert.equal(existsSync(resolve(dir, 'matrix-session.json')), false);
});

await test('Matrix bridge prefixes rider names, handles commands and stops after close', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Matrix Rider', 'test-password');
  const sent: Array<string> = [];
  const presence: Array<number> = [];

  const runtime = {
    ...f,
    config: validateConfig({
      storageDir: f.config.storageDir,
      integrations: { matrix: { helpMessage: 'Help text', announcePlayers: true } },
    }),
  };

  const bridge = Effect.runSync(
    matrixService(runtime).bridge({
      send: (content) => {
        sent.push(content);

        return Promise.resolve();
      },
      presence: (count) => {
        presence.push(count);
      },
      close: () => Promise.resolve(),
    }),
  );

  f.world.online.set(BigInt(user.player_id), create(PlayerStateSchema));
  bridge.receive('Alice', 'Ride on!');
  const update = f.world.updates.get(BigInt(user.player_id))?.[0];
  assert.ok(update);
  const action = fromBinary(SocialPlayerActionSchema, update.payload);
  assert.equal(action.firstName, 'Alice');
  assert.equal(action.message, 'Ride on!');
  bridge.receive('Alice', '!online');
  bridge.receive('Alice', '!help');
  bridge.receive('Alice', '!ping');
  bridge.receive('Alice', '!unknown');
  bridge.online(BigInt(user.player_id), true);
  await until(() => sent.length === 4);
  const profile = f.profiles.get(user.player_id);
  assert.deepEqual(sent, ['1 riders online', 'Help text', 'pong', `${profile.firstName} ${profile.lastName}: Riding`]);
  assert.deepEqual(presence, [1]);
  await bridge.close();
  bridge.send('after close');
  bridge.receive('Alice', '!ping');
  await sleep(10);
  assert.equal(sent.length, 4);
});
