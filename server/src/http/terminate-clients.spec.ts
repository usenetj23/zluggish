import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { terminateClients } from '#src/http/terminate-clients';

type FakeClient = { terminate(): void; terminated: number };

function fakeClient(): FakeClient {
  const client = {
    terminated: 0,
    terminate() {
      client.terminated += 1;
    },
  };

  return client;
}

await test('every client is terminated exactly once and the count is returned', { timeout: 20_000 }, () => {
  const clients = [fakeClient(), fakeClient(), fakeClient()];

  assert.equal(terminateClients({ clients }), 3);

  for (const client of clients) {
    assert.equal(client.terminated, 1);
  }
});

await test(
  'a client that removes itself from the set while terminating does not break the loop',
  { timeout: 20_000 },
  () => {
    const clients = new Set<FakeClient>();

    for (const [index, client] of [fakeClient(), fakeClient()].entries()) {
      if (index === 0) {
        const removing = {
          get terminated() {
            return client.terminated;
          },
          terminate: () => {
            client.terminate();
            clients.delete(removing);
          },
        };

        clients.add(removing);
      } else {
        clients.add(client);
      }
    }

    assert.equal(terminateClients({ clients }), 2);
    assert.equal([...clients][0]?.terminated, 1);
  },
);

await test('an empty server returns 0', { timeout: 20_000 }, () => {
  assert.equal(terminateClients({ clients: new Set<FakeClient>() }), 0);
});

await test(
  'a real WebSocket client is terminated and emits close within two seconds',
  { timeout: 20_000 },
  async () => {
    const server = new WebSocketServer({ port: 0 });

    try {
      await once(server, 'listening');

      const address = server.address();

      assert.ok(address && typeof address === 'object');

      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);

      try {
        await once(client, 'open');
        assert.equal(terminateClients(server), 1);
        await once(client, 'close');
      } finally {
        client.terminate();
      }
    } finally {
      const closing = once(server, 'close');

      server.close();
      await closing;
    }
  },
);
