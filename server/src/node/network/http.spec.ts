import { startHttp } from '#src/node/network/http';
import { upgradeWebSocket } from '@hono/node-server';
import type { WebSocketServerLike } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

/**
`startHttp` hands the HTTP upgrades of a WebSocket route to the WebSocket server it is given: without
one, `upgradeWebSocket` routes never get a socket on a real listener.
*/

await test('a WebSocket route answers on a real listener started with a WebSocket server', async (t) => {
  const app = new Hono();

  app.get(
    '/echo',
    upgradeWebSocket(() => ({
      onMessage: (event, ws) => {
        ws.send(`echo ${String(event.data)}`);
      },
    })),
  );

  const server = new WebSocketServer({ noServer: true });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see `webSocketServerOf` in main.ts
  const listener = startHttp(app, { host: '127.0.0.1', port: 0, websocket: { server: server as WebSocketServerLike } });

  t.after(() => {
    server.close();
    listener.close();
  });

  await once(listener, 'listening');

  const address = listener.address();

  assert.ok(address !== null && typeof address === 'object', 'the listener has no address');

  const { port } = address;
  const client = new WebSocket(`ws://127.0.0.1:${port}/echo`);

  t.after(() => client.terminate());

  await once(client, 'open');
  client.send('hello');

  const [data] = await once(client, 'message');

  assert.equal(String(data), 'echo hello');
});
