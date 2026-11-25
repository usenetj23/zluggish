import { serve } from '@hono/node-server';
import { createServer } from 'node:https';
import type { WebSocketServerLike } from '@hono/node-server';
import type { Hono } from 'hono';

export interface HttpListenerOptions {
  host: string;
  port: number;
  requestTimeout?: number;
  tls?: { cert: Buffer | string; key: Buffer | string };
  /** The server that takes over the HTTP upgrades of the WebSocket routes (see `upgradeWebSocket`). */
  websocket?: { server: WebSocketServerLike };
}

export function startHttp(app: Pick<Hono, 'fetch'>, options: HttpListenerOptions) {
  const plain = {
    fetch: app.fetch,
    hostname: options.host,
    port: options.port,
  };
  // `exactOptionalPropertyTypes` rejects an explicit `undefined`, so the key is only there when set.
  const common = options.websocket ? { ...plain, websocket: options.websocket } : plain;

  if (options.tls) {
    return serve({
      ...common,
      createServer,
      serverOptions: { ...options.tls, requestTimeout: options.requestTimeout },
    });
  }

  return serve({ ...common, serverOptions: { requestTimeout: options.requestTimeout } });
}
