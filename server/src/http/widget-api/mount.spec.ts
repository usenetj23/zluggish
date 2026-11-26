import {
  widgetAthleteInfoSchema,
  widgetGroupRecordSchema,
  widgetNearbyRecordSchema,
  widgetStatsDraftMetricSchema,
  widgetStatsMetricSchema,
  widgetStatsPowerMetricSchema,
} from '#src/dtos/widget-api.dto';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import { mountWidgetApi } from '#src/http/widget-api/mount';
import { answerOf } from '#tests/support/rpc';
import { maxConnectionsPerRider, maxSubscriptions } from '#src/http/widget-api/socket';
import type { WebEnv } from '#src/http/web-app';
import type { WidgetView } from '#src/http/widget-view';
import { widgetView } from '#src/http/widget-view';
import type { ChatMessage } from '#src/world/chat-log';
import { World } from '#src/world/state';
import { ChatLog } from '#src/world/chat-log';
import { AthleteDataStore } from '#src/world/athlete-data-store';
import type { AthleteDataValue } from '#src/world/athlete-data-store';
import { ModRegistry } from '#src/world/mods-registry';
import { PlayerProfileSchema, Sport } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema, WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { create } from '@bufbuild/protobuf';
import { Option, Schema } from 'effect';
import { serve } from '@hono/node-server';
import type { WebSocketServerLike } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocket as RawClient, WebSocketServer } from 'ws';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

/** course 6, road 100, travelling the road forwards. */
const roadFlag = (6 << 16) | 4;

const road100 = 100 << 8;

/** One rider on course 6, road 100, riding forwards at 36 km/h and 200 W. */
const packet = (id: bigint, x: number): PlayerState =>
  create(PlayerStateSchema, {
    id,
    distance: 10_000,
    roadTime: 100_000,
    laps: 0,
    speed: 36_000_000,
    heartrate: 140,
    power: 200,
    time: 60,
    f19: roadFlag,
    aux3: road100,
    x,
    yAltitude: 4200,
    z: 30,
    sport: Sport.CYCLING,
    route: 0,
  });

const identity = create(PlayerProfileSchema, {
  firstName: 'John',
  lastName: 'Smith',
  isMale: true,
  weightInGrams: 72_500,
  ftp: 250,
});

/** Two riders on one road: the watched rider 1 and rider 2 fifty metres ahead of it. */
const viewOf = () =>
  widgetView({
    watchingId: 1,
    states: [packet(1n, 1_000_000), packet(2n, 1_005_000)],
    stats: () => {},
    profile: () => identity,
  });

/** One chat message with everything a test does not care about filled in. */
const chatMessage = (over: Partial<ChatMessage> = {}): ChatMessage => ({
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

/** The chat log and the listener bookkeeping a fake world hands to `WidgetDeps`. */
type Chatter = { log: ChatLog; listeners: { open: number } };

const chatter = (): Chatter => ({ log: new ChatLog(), listeners: { open: 0 } });

/** The settings of every rider in memory, one map per rider. */
const settingsStore = (): WidgetDeps['settings'] => {
  const stored = new Map<number, Map<string, AthleteDataValue>>();

  return {
    get: (viewerId, key) => stored.get(viewerId)?.get(key),
    set: (viewerId, key, setting) => {
      stored.set(viewerId, new Map(stored.get(viewerId)).set(key, setting));

      return true;
    },
  };
};

const athleteDataOf = (store: AthleteDataStore): WidgetDeps['athleteData'] => ({
  update: (viewer, athleteId, data) => store.update(viewer, athleteId, data),
});

/** A signed-in rider, this server's Origin and a world of two riders, unless a test says otherwise. */
const depsOf = (logged: Array<string>, overrides: Partial<WidgetDeps> = {}, talk: Chatter = chatter()): WidgetDeps => ({
  viewer: () => 1,
  originAllowed: () => true,
  refererAllowed: () => true,
  view: viewOf,
  listenChat: (viewerId, listener) => {
    talk.listeners.open += 1;

    const dispose = talk.log.listen(viewerId, listener);

    return () => {
      talk.listeners.open -= 1;
      dispose();
    };
  },
  chatHistory: (viewerId) => talk.log.history(viewerId, 100),
  pushIntervalMs: 40,
  log: (event, message) => {
    logged.push(`${event} ${message}`);
  },
  settings: settingsStore(),
  athleteData: athleteDataOf(new AthleteDataStore()),
  // A mods folder that does not exist: no mod at all.
  mods: new ModRegistry('/nonexistent/zluggish-mods'),
  modStore: {
    directory: () => Promise.resolve([]),
    download: () => Promise.reject(new Error('unknown store mod')),
    downloadGitHub: () => Promise.reject(new Error('invalid repository')),
  },
  isAdministrator: () => false,
  ...overrides,
});

const web = (deps: WidgetDeps) => {
  const app = new Hono<WebEnv>();
  mountWidgetApi(app, deps);

  return app;
};

const get = (deps: WidgetDeps, path: string) => web(deps).request(`http://local:8080${path}`);

const post = (deps: WidgetDeps, path: string, body: unknown) =>
  web(deps).request(`http://local:8080${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** One v2 argument, base64url encoded the way the widget transport encodes it. */
const arg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A nearby record is only worth handing over if a widget page could read it. */
const assertNearby = (record: unknown) => {
  assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetNearbyRecordSchema)(record));
};

/** The two series of a metric when the event name carries no `/v2` suffix: objects keyed by the period
in seconds, `smooth` holding the average itself and `peaks` an object per period. */
const keyedSeries = {
  smooth: Schema.Record(Schema.String, Schema.Finite),
  peaks: Schema.Record(Schema.String, Schema.Struct({ avg: Schema.optional(Schema.NullOr(Schema.Finite)) })),
};

/** A nearby record of an event without the `/v2` suffix: the shared schema with keyed series. */
const v1RecordSchema = Schema.Struct({
  ...widgetNearbyRecordSchema.fields,
  stats: Schema.Struct({
    ...widgetNearbyRecordSchema.fields.stats.fields,
    power: Schema.Struct({ ...widgetStatsPowerMetricSchema.fields, ...keyedSeries }),
    speed: Schema.Struct({ ...widgetStatsMetricSchema.fields, ...keyedSeries }),
    hr: Schema.Struct({ ...widgetStatsMetricSchema.fields, ...keyedSeries }),
    draft: Schema.Struct({ ...widgetStatsDraftMetricSchema.fields, ...keyedSeries }),
  }),
});

/** A record of an event without the `/v2` suffix: keyed statistics with an entry for every peak period,
because the pages read `peaks[300].avg` unconditionally. */
const assertNearbyV1 = (record: unknown) => {
  const { stats } = Schema.decodeUnknownSync(v1RecordSchema)(record);

  for (const metric of [stats.power, stats.speed, stats.hr, stats.draft]) {
    assert.equal(Array.isArray(metric.smooth), false);
    assert.equal(Array.isArray(metric.peaks), false);
    assert.equal(typeof metric.peaks['300'], 'object');
  }
};

await test('an anonymous rider is turned away from the RPC endpoints', { timeout: 10_000 }, async () => {
  const anonymous = depsOf([], { viewer: () => null });

  for (const response of [
    await get(anonymous, '/api/rpc/v2/getNearbyData'),
    await post(anonymous, '/api/rpc/v1/getNearbyData', []),
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { name: 'AuthenticationError', message: 'Sign in first.', stack: '' },
    });
  }
});

await test('the game connection of a signed-in rider is reported as live', { timeout: 10_000 }, async () => {
  const response = await get(depsOf([]), '/api/rpc/v2/getGameConnectionStatus');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, value: { connected: true } });
});

/** Zluggish has no overlay windows (an Electron feature), so the Overview page always hears
'visible' and never greys its bar out. */
await test('getOverlayWindowsVisibilityState always answers visible', { timeout: 20_000 }, async () => {
  const response = await get(depsOf([]), '/api/rpc/v2/getOverlayWindowsVisibilityState');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, value: 'visible' });
});

await test('getPowerZones answers the seven Coggan zones of the FTP asked for', { timeout: 20_000 }, async () => {
  const deps = depsOf([]);

  for (const path of ['/api/rpc/v2/getPowerZones', `/api/rpc/v2/getPowerZones/${arg(1)}`]) {
    const response = await get(deps, path);

    assert.equal(response.status, 200);

    const payload = await answerOf(
      response,
      Schema.Array(
        Schema.Struct({
          zone: Schema.String,
          name: Schema.String,
          from: Schema.Finite,
          to: Schema.NullOr(Schema.Finite),
        }),
      ),
    );

    assert.equal(payload.success, true);
    assert.equal(payload.value.length, 7);
    assert.equal(payload.value[0]?.zone, 'Z1');
    assert.equal(payload.value[0]?.from, 0);
    assert.ok((payload.value[0]?.name.length ?? 0) > 0);
    assert.equal(payload.value.at(-1)?.zone, 'Z7');
    assert.equal(payload.value.at(-1)?.to, null);
  }
});

await test('nearby and group payloads are the real view of the signed-in rider', { timeout: 10_000 }, async () => {
  const deps = depsOf([]);

  for (const response of [
    await get(deps, '/api/rpc/v2/getNearbyData'),
    await post(deps, '/api/rpc/v1/getNearbyData', []),
  ]) {
    assert.equal(response.status, 200);

    const payload = await answerOf(response, Schema.Array(Schema.Unknown));

    assert.equal(payload.success, true);
    assert.equal(payload.value.length, 2);

    for (const record of payload.value) {
      assertNearby(record);
    }
  }

  const groups = await answerOf(await get(deps, '/api/rpc/v2/getGroupsData'), Schema.Array(Schema.Unknown));

  assert.equal(groups.success, true);
  assert.ok(groups.value.length > 0);

  for (const group of groups.value) {
    assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetGroupRecordSchema)(group));
  }
});

await test(
  'the athlete records name the watched rider and the rider asked for by id',
  { timeout: 10_000 },
  async () => {
    const deps = depsOf([]);
    const idOf = async (path: string) => {
      const payload = await answerOf(await get(deps, path), Schema.NullOr(Schema.Struct({ athleteId: Schema.Finite })));

      assert.equal(payload.success, true);

      return payload.value?.athleteId ?? null;
    };

    assert.equal(await idOf('/api/rpc/v2/getAthleteData'), 1);
    assert.equal(await idOf(`/api/rpc/v2/getAthleteData/${arg('self')}`), 1);
    assert.equal(await idOf(`/api/rpc/v2/getAthleteData/${arg(2)}`), 2);
    assert.equal(await idOf(`/api/rpc/v2/getAthleteData/${arg(999)}`), null);

    const many = await answerOf(
      await get(deps, `/api/rpc/v2/getAthletesData/${arg([1, 2, 999])}`),
      Schema.Array(Schema.Unknown),
    );

    assert.equal(many.value.length, 2);

    for (const record of many.value) {
      assertNearby(record);
    }
  },
);

await test('getAthletes answers per asked id, in the order and length of the list', { timeout: 20_000 }, async () => {
  const deps = depsOf([]);

  const athletesOf = async (path: string, body?: unknown) => {
    const response =
      body === undefined ? await get(deps, path) : await post(deps, path.replace('/api/rpc/v2', '/api/rpc/v1'), body);

    assert.equal(response.status, 200);

    const payload = await answerOf(response, Schema.Array(Schema.Unknown));

    assert.equal(payload.success, true);

    return payload.value;
  };

  for (const athletes of [
    await athletesOf(`/api/rpc/v2/getAthletes/${arg([1, 2, 999])}`),
    await athletesOf('/api/rpc/v1/getAthletes', [[1, 2, 999]]),
  ]) {
    assert.equal(athletes.length, 3);

    for (const athlete of athletes.slice(0, 2)) {
      assert.notEqual(Schema.decodeUnknownSync(widgetAthleteInfoSchema)(athlete).fLast, '');
    }

    assert.equal(athletes[2], null);

    // The same order the ids were asked in: rider 1 first, rider 2 second.
    for (const [place, asked] of [1, 2].entries()) {
      const one = await answerOf(
        await get(deps, `/api/rpc/v2/getAthleteData/${arg(asked)}`),
        Schema.Struct({ athlete: Schema.Unknown }),
      );

      assert.deepEqual(athletes[place], one.value.athlete);
    }
  }
});

await test(
  'getAthletes reads `self` as the watched rider and a non-list as no ids at all',
  { timeout: 20_000 },
  async () => {
    const deps = depsOf([]);

    const watched = await answerOf(
      await get(deps, '/api/rpc/v2/getAthleteData'),
      Schema.Struct({ athlete: Schema.Unknown }),
    );

    for (const asked of ['self', 'watching']) {
      const payload = await answerOf(
        await get(deps, `/api/rpc/v2/getAthletes/${arg([asked])}`),
        Schema.Array(Schema.Unknown),
      );

      assert.equal(payload.success, true);
      assert.equal(payload.value.length, 1);
      assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetAthleteInfoSchema)(payload.value[0]));
      assert.deepEqual(payload.value[0], watched.value.athlete);
    }

    for (const body of [{ not: 'an array' }, 'a string', 7, '{not json']) {
      const payload = await answerOf(await post(deps, '/api/rpc/v1/getAthletes', body), Schema.Array(Schema.Unknown));

      assert.equal(payload.success, true);
      assert.deepEqual(payload.value, []);
    }
  },
);

await test(
  'the remaining reads answer an acknowledged nothing, everything else stays not implemented',
  { timeout: 20_000 },
  async () => {
    const deps = depsOf([]);

    for (const name of ['getEventSubgroup', 'getEvent', 'getSentryConfig']) {
      const response = await get(deps, `/api/rpc/v2/${name}`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, value: null });
    }

    for (const name of ['getPacePartnerData', 'getEvents']) {
      const response = await get(deps, `/api/rpc/v2/${name}`);

      assert.deepEqual(await response.json(), {
        success: false,
        error: { name: 'NotImplementedError', message: `not implemented: ${name}`, stack: '' },
      });
    }
  },
);

await test('getAthleteStreams answers every stream of the Watching chart empty, since no ride history is kept', async () => {
  const response = await get(depsOf([]), `/api/rpc/v2/getAthleteStreams/${arg('self')}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    value: { time: [], power: [], hr: [], speed: [], cadence: [], draft: [], wbal: [] },
  });
});

await test('getChatHistory answers the public messages and the own direct ones, never those of others', async () => {
  const talk = chatter();

  talk.log.record(chatMessage({ from: 2, to: 0, message: 'to everybody' }));
  talk.log.record(chatMessage({ from: 2, to: 1, message: 'to the viewer' }));
  talk.log.record(chatMessage({ from: 2, to: 3, message: 'to somebody else' }));

  const response = await get(depsOf([], {}, talk), '/api/rpc/v2/getChatHistory');
  const payload = await answerOf(response, Schema.Array(Schema.Struct({ message: Schema.String })));

  assert.equal(payload.success, true);
  assert.deepEqual(payload.value?.map((x) => x.message).toSorted(), ['to everybody', 'to the viewer']);
});

await test('a v1 body that is not an array carries no arguments instead of failing', { timeout: 10_000 }, async () => {
  const deps = depsOf([]);

  for (const body of [{ not: 'an array' }, '{not json']) {
    const response = await post(deps, '/api/rpc/v1/getAthleteData', body);

    assert.equal(response.status, 200);

    const payload = await answerOf(response, Schema.NullOr(Schema.Struct({ athleteId: Schema.Finite })));

    assert.equal(payload.success, true);
    assert.equal(payload.value?.athleteId, 1);
  }
});

await test(
  'the alpha.7 options of getAthlete and getAthleteData change nothing, since all data is local',
  { timeout: 20_000 },
  async () => {
    const deps = depsOf([]);
    const options = { refresh: true, required: ['equipment', 'competitionMetrics'] };

    const plainResponse = await get(deps, `/api/rpc/v2/getAthleteData/${arg('self')}`);
    const plain = await plainResponse.json();
    const askedResponse = await get(deps, `/api/rpc/v2/getAthleteData/${arg('self')}/${arg(options)}`);
    const asked = await askedResponse.json();

    assert.deepEqual(asked, plain);

    const plainAthleteResponse = await get(deps, `/api/rpc/v2/getAthlete/${arg('self')}`);
    const plainAthlete = await plainAthleteResponse.json();
    const askedAthleteResponse = await get(deps, `/api/rpc/v2/getAthlete/${arg('self')}/${arg(options)}`);
    const askedAthlete = await askedAthleteResponse.json();

    assert.deepEqual(askedAthlete, plainAthlete);

    // The v1 form carries the same option as its 2nd body argument.
    const v1Response = await post(deps, '/api/rpc/v1/getAthleteData', ['self', options]);
    const v1 = await v1Response.json();

    assert.deepEqual(v1, plain);
  },
);

await test(
  'an unknown method keeps answering not implemented and a broken argument 400',
  {
    timeout: 10_000,
  },
  async () => {
    const deps = depsOf([]);

    const unknown = await get(deps, '/api/rpc/v2/getPacePartnerData');

    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), {
      success: false,
      error: { name: 'NotImplementedError', message: 'not implemented: getPacePartnerData', stack: '' },
    });

    // Not base64url JSON at all: the segments decode to bytes no parser can read.
    const broken = await get(deps, '/api/rpc/v2/getNearbyData/not-json');

    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), {
      success: false,
      error: { name: 'ArgumentError', message: 'bad arguments', stack: '' },
    });
  },
);

/** Serves the mounted routes over a real socket server and hands back the port it settled on. */
async function serving(deps: WidgetDeps) {
  const wss = new WebSocketServer({ noServer: true });

  // `serve` starts listening asynchronously: the port is only trustworthy once the listening listener fires.
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    // SAFETY: the `ws` server is the one `@hono/node-server` is built for; its typings only differ in
    // declaring `options.noServer` as `boolean | undefined` under exact optional property types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, quality/no-chained-type-assertions
    const websocketServer = wss as unknown as WebSocketServerLike;
    const server = serve(
      { fetch: web(deps).fetch, hostname: '127.0.0.1', port: 0, websocket: { server: websocketServer } },
      (info: AddressInfo) => resolve({ server, port: info.port }),
    );
  });

  const close = async () => {
    wss.close();
    // These options build a plain http.Server; closeAllConnections is missing only from the http2 branch of ServerType.
    if ('closeAllConnections' in server) {
      server.closeAllConnections();
    }

    await new Promise<void>((done) => {
      server.close(() => done());
    });
  };

  return { port, close };
}

/** The status of an upgrade the server refuses; a socket that stays open past the watchdog fails the test. */
async function rejectedUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  const client = new RawClient(`ws://127.0.0.1:${port}/api/ws/events`, { headers });

  try {
    return await new Promise<number>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('the upgrade was not refused within 5 s')), 5000);

      client.on('unexpected-response', (_request, response: IncomingMessage) => {
        clearTimeout(watchdog);
        resolve(response.statusCode ?? 0);
      });
      client.on('error', (error: Error) => {
        clearTimeout(watchdog);
        reject(error);
      });
    });
  } finally {
    client.terminate();
  }
}

await test('an anonymous rider and a foreign Origin never reach the event socket', { timeout: 15_000 }, async () => {
  const anonymous = await serving(depsOf([], { viewer: () => null }));

  try {
    assert.equal(await rejectedUpgrade(anonymous.port, {}), 401);
  } finally {
    await anonymous.close();
  }

  const foreign = await serving(depsOf([], { originAllowed: () => false }));

  try {
    assert.equal(await rejectedUpgrade(foreign.port, { Origin: 'http://evil.example' }), 403);
  } finally {
    await foreign.close();
  }
});

/** A subscribe frame of the browser transport. */
const subscribe = (event: string, subId: string) =>
  JSON.stringify({ type: 'request', data: { method: 'subscribe', arg: { event, subId } } });

/** The unsubscribe frame of the browser transport for the `s1` subscription. */
const unsubscribe = (event: string) =>
  JSON.stringify({ type: 'request', data: { method: 'unsubscribe', arg: { event, subId: 's1' } } });

/** The frames of the client in `assets/sauce/pages/src/common.mjs`: numeric `uid` and `subId`, and
`unsubscribe` addressing its subscription by `subId` alone. */
const clientSubscribe = (event: string, uid: unknown, subId: unknown) =>
  JSON.stringify({ type: 'request', uid, data: { method: 'subscribe', arg: { event, subId } } });

const clientUnsubscribe = (uid: unknown, subId: unknown) =>
  JSON.stringify({ type: 'request', uid, data: { method: 'unsubscribe', arg: { subId } } });

/** One frame of the event socket: the `uid` is the `subId` it belongs to, or the `uid` of the request a
`response` answers; the browser client counts both up, so both are numbers there. */
const frameSchema = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  uid: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

type Frame = typeof frameSchema.Type;

/** One frame the server sent, parsed and checked against the frame shape every test reads. */
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(frameSchema));

/** A client that finished its handshake, plus every frame it was sent, in the order they arrived. */
interface Client {
  socket: RawClient;
  frames: Array<Frame>;
  /** How many frames carry this `uid`, whatever its type. */
  for: (uid: string | number) => number;
}

/** The data of the first frame of one subscription, as it arrived. */
const dataOf = (client: Client, uid: string) => client.frames.find((frame) => frame.uid === uid)?.data;

/** A frame payload that has to be a list. */
const listOf = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));

/** The id and the watching flag every athlete record and `states` entry starts with. */
const headOf = Schema.decodeUnknownSync(
  Schema.Struct({ athleteId: Schema.Finite, watching: Schema.optional(Schema.Boolean) }),
);

/** The text of a chat frame, or undefined for any other frame. */
const messageOf = (data: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(data))?.message;

/** Opens an event socket and collects its frames; a socket that never opens fails within 5 s. */
async function connected(port: number): Promise<Client> {
  const socket = new RawClient(`ws://127.0.0.1:${port}/api/ws/events`);
  const frames: Array<Frame> = [];

  socket.on('message', (text: RawClient.RawData) => {
    frames.push(decodeFrame(String(text)));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('the event socket did not open within 5 s')), 5000);

      socket.once('open', () => {
        clearTimeout(watchdog);
        resolve();
      });
      socket.once('error', (error: Error) => {
        clearTimeout(watchdog);
        reject(error);
      });
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }

  return {
    socket,
    frames,
    for: (subId: string | number) => frames.filter((frame) => frame.uid === subId).length,
  };
}

/** Waits until `ready` holds, asking every 10 ms; what never arrives fails the test after `limitMs`. */
async function waitFor(ready: () => boolean, what = 'that'): Promise<void> {
  const limitMs = 5000;

  const deadline = Date.now() + limitMs;

  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${limitMs} ms`);
    }

    await sleep(10);
  }
}

/** Only for checking that a quiet server stays quiet; an assertion never waits on this. */
const sleep = (ms: number) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** A client that gets in even while the rider is at their connection limit: asks again until a seat frees. */
async function openedAtLast(port: number, limitMs = 5000): Promise<Client> {
  const deadline = Date.now() + limitMs;

  for (;;) {
    try {
      return await connected(port);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`no event socket was let in within ${limitMs} ms`);
      }

      await sleep(50);
    }
  }
}

/** Closes a client and waits for the server to notice; every test ends this way, so timers can be checked. */
const dropped = async (client: Client): Promise<void> => {
  client.socket.terminate();
  await sleep(150);
};

await test(
  'a nearby subscription is answered at once and pushed again on every tick',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('nearby', 's1'));

      await waitFor(() => client !== undefined && client.frames.length > 0, 'the first frame');

      const first = client.frames[0];

      assert.ok(first);
      assert.equal(first.success, true);
      assert.equal(first.type, 'event');
      assert.equal(first.uid, 's1');

      const records = listOf(first.data);

      assert.equal(records.length, 2);

      for (const record of records) {
        assertNearbyV1(record);
      }

      // The same subscription keeps being fed without being asked for again.
      await waitFor(() => client !== undefined && client.for('s1') >= 3, 'two more pushed frames');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

/** One `states` entry is the rider's state plus its id: no athlete info, no ftp or weight. */
const assertStateEntry = (entry: unknown) => {
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(Schema.Struct({ athleteId: Schema.Finite, power: Schema.Finite, speed: Schema.Finite }))(
      entry,
    ),
  );
  assert.ok(typeof entry === 'object' && entry !== null);

  for (const key of ['athlete', 'ftp', 'weight']) {
    assert.equal(key in entry, false, `a states entry carries ${key}`);
  }
};

await test(
  'a states subscription is answered at once and pushed again on every tick',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('states', 's1'));

      await waitFor(() => client !== undefined && client.frames.length > 0, 'the first frame');

      const first = client.frames[0];

      assert.ok(first);
      assert.equal(first.success, true);
      assert.equal(first.type, 'event');
      assert.equal(first.uid, 's1');

      const entries = listOf(first.data);

      assert.equal(entries.length, 2);
      assert.deepEqual(
        entries.map((entry) => headOf(entry).athleteId),
        [1, 2],
      );

      for (const entry of entries) {
        assertStateEntry(entry);
      }

      // The very state the nearby records carry, and nothing of the athlete around it.
      assert.equal(Schema.decodeUnknownSync(Schema.Struct({ power: Schema.Finite }))(entries[0]).power, 200);

      // The same subscription keeps being fed without being asked for again.
      await waitFor(() => client !== undefined && client.for('s1') >= 3, 'two more pushed frames');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test('an anonymous rider never reaches a states subscription', { timeout: 15_000 }, async () => {
  const anonymous = await serving(depsOf([], { viewer: () => null }));

  try {
    assert.equal(await rejectedUpgrade(anonymous.port, {}), 401);
  } finally {
    await anonymous.close();
  }
});

await test('unsubscribing from states stops its push', { timeout: 20_000 }, async () => {
  const { port, close } = await serving(depsOf([]));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(subscribe('states', 's1'));

    await waitFor(() => client !== undefined && client.for('s1') >= 3, 'a few pushed frames');

    client.socket.send(unsubscribe('states'));
    await sleep(150);

    const settled = client.for('s1');

    assert.ok(settled >= 3);

    await sleep(250);

    assert.equal(client.for('s1'), settled);
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    await close();
  }
});

await test('two subscriptions are each pushed with their own payload', { timeout: 20_000 }, async () => {
  const { port, close } = await serving(depsOf([]));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(subscribe('nearby', 'near'));
    client.socket.send(subscribe('groups/v2', 'packs'));

    await waitFor(
      () => client !== undefined && client.for('near') > 0 && client.for('packs') > 0,
      'a frame for each subscription',
    );
    await waitFor(
      () => client !== undefined && client.for('near') >= 2 && client.for('packs') >= 2,
      'a push for each subscription',
    );

    assert.ok(new Set(client.frames.map((frame) => frame.uid)).size >= 2);

    const packs = listOf(dataOf(client, 'packs'));

    assert.ok(packs.length > 0);

    for (const group of packs) {
      assert.doesNotThrow(() => Schema.decodeUnknownSync(widgetGroupRecordSchema)(group));
    }
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    await close();
  }
});

/** The four metrics with series, whatever else `stats` may carry. */
const seriesOf = (record: unknown) => {
  const series = Schema.Struct({ smooth: Schema.Unknown, peaks: Schema.Unknown });
  const { stats } = Schema.decodeUnknownSync(
    Schema.Struct({ stats: Schema.Struct({ power: series, speed: series, hr: series, draft: series }) }),
  )(record);

  return [stats.power, stats.speed, stats.hr, stats.draft];
};

await test(
  'the nearby streams differ only in the shape of their statistics: v1 keyed, v2 arrays',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('nearby', 'old'));
      client.socket.send(subscribe('nearby/v2', 'new'));
      client.socket.send(subscribe('groups/v2', 'packs'));

      await waitFor(
        () => client !== undefined && client.for('old') > 0 && client.for('new') > 0 && client.for('packs') > 0,
        'a frame for each of the three subscriptions',
      );

      const keyed = listOf(dataOf(client, 'old') ?? []);
      const arrays = listOf(dataOf(client, 'new') ?? []);

      assert.ok(keyed.length > 0);
      assert.equal(keyed.length, arrays.length);

      for (const record of keyed) {
        assertNearbyV1(record);
      }

      for (const record of arrays) {
        assertNearby(record);

        for (const metric of seriesOf(record)) {
          assert.ok(Array.isArray(metric.smooth));
          assert.ok(Array.isArray(metric.peaks));
        }
      }

      // The groups page is v2 only, and both names carry the very same array shape.
      const packs = Schema.decodeUnknownSync(Schema.Array(widgetGroupRecordSchema))(dataOf(client, 'packs') ?? []);

      assert.ok(packs.length > 0);

      for (const group of packs) {
        for (const athlete of group.athletes) {
          assert.ok(Array.isArray(athlete.stats.power.smooth));
        }
      }
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'the athlete streams differ only in the shape of their statistics: v1 keyed, v2 arrays',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('athlete/self', 'old'));
      client.socket.send(subscribe('athlete/self/v2', 'new'));

      await waitFor(
        () => client !== undefined && client.for('old') > 0 && client.for('new') > 0,
        'a frame for each of the two subscriptions',
      );

      const keyed = dataOf(client, 'old');
      const arrays = dataOf(client, 'new');

      assert.equal(headOf(keyed).athleteId, 1);
      assert.equal(headOf(arrays).athleteId, 1);

      assertNearbyV1(keyed);
      assertNearby(arrays);

      for (const metric of seriesOf(arrays)) {
        assert.ok(Array.isArray(metric.smooth));
      }
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'an athlete subscription answers the watched rider and says nothing about an unknown one',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('athlete/self', 'me'));
      client.socket.send(subscribe('athlete/999', 'nobody'));

      await waitFor(() => client !== undefined && client.for('me') > 0, 'the record of the watched rider');

      const record = dataOf(client, 'me');

      assert.equal(headOf(record).athleteId, 1);
      assert.equal(headOf(record).watching, true);
      assertNearbyV1(record);

      await sleep(250);

      assert.equal(client.for('nobody'), 0);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

const idle = (): WidgetView => ({ nearby: [], groups: [], self: null, byId: new Map() });

await test(
  'an athlete subscription opened before the ride starts is fed as soon as the rider is on the road',
  { timeout: 20_000 },
  async () => {
    // An empty world first: no rider is on the road, so `athlete/self` and `athlete/2` have no record yet.
    let riding = false;
    const { port, close } = await serving(depsOf([], { view: () => (riding ? viewOf() : idle()) }));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('athlete/self', 'me'));
      client.socket.send(subscribe('athlete/2', 'other'));

      // Nothing to hand over yet, and the push loop still has to stay quiet.
      await sleep(250);

      assert.equal(client.for('me'), 0);
      assert.equal(client.for('other'), 0);

      riding = true;

      await waitFor(
        () => client !== undefined && client.for('me') > 0 && client.for('other') > 0,
        'a pushed frame once the ride started',
      );

      const mine = dataOf(client, 'me');
      const other = dataOf(client, 'other');

      assert.equal(headOf(mine).athleteId, 1);
      assert.equal(headOf(mine).watching, true);
      assertNearbyV1(mine);

      assert.equal(headOf(other).athleteId, 2);
      assertNearbyV1(other);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test('unsubscribing stops the push of that subscription', { timeout: 20_000 }, async () => {
  const { port, close } = await serving(depsOf([]));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(subscribe('nearby', 's1'));

    await waitFor(() => client !== undefined && client.for('s1') >= 3, 'a few pushed frames');

    client.socket.send(unsubscribe('nearby'));
    await sleep(150);

    const settled = client.for('s1');

    assert.ok(settled >= 3);

    await sleep(250);

    assert.equal(client.for('s1'), settled);
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    await close();
  }
});

await test('a client that goes away leaves no push loop behind', { timeout: 20_000 }, async () => {
  let asked = 0;
  const counting = (): WidgetView => {
    asked += 1;

    return viewOf();
  };
  const { port, close } = await serving(depsOf([], { view: counting }));
  const client = await connected(port);

  try {
    client.socket.send(subscribe('nearby', 's1'));

    await waitFor(() => asked > 1, 'the push loop to ask for the view');

    client.socket.terminate();
    await sleep(150);

    const settled = asked;

    await sleep(250);

    assert.equal(asked, settled);
  } finally {
    client.socket.terminate();
    await close();
  }
});

await test(
  'a status is reported once and an unknown event is only acknowledged once',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('status', 'state'));
      client.socket.send(subscribe('mystery', 'odd'));

      await waitFor(() => client !== undefined && client.for('state') > 0 && client.for('odd') > 0, 'both answers');

      assert.deepEqual(client.frames.find((frame) => frame.uid === 'state')?.data, { connected: true });
      assert.deepEqual(client.frames.find((frame) => frame.uid === 'odd')?.data, []);

      await sleep(250);

      assert.equal(client.for('state'), 1);
      assert.equal(client.for('odd'), 1);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

/** The Overview page compares the event data with 'visible' and greys its bar out for anything else,
so the event answers exactly that string once and stays quiet: Zluggish has no overlay windows. */
await test(
  'an overlay-windows-visibility subscription answers the string visible exactly once',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('overlay-windows-visibility', 'win'));

      await waitFor(() => client !== undefined && client.for('win') > 0, 'the visible answer');

      assert.equal(client.frames.find((frame) => frame.uid === 'win')?.data, 'visible');

      await sleep(250);

      assert.equal(client.for('win'), 1);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'a chat message recorded after the session ends is not delivered and closes the socket with 1008',
  { timeout: 20_000 },
  async () => {
    const chatterRoom = chatter();
    let signedIn: number | null = 1;
    const { port, close } = await serving(depsOf([], { viewer: () => signedIn }, chatterRoom));
    let client: Client | undefined;
    let closing: { code: number; reason: string } | undefined;

    try {
      client = await connected(port);
      client.socket.on('close', (code: number, reason: Buffer) => {
        closing = { code, reason: String(reason) };
      });
      client.socket.send(clientSubscribe('chat', 7, 3));

      await waitFor(() => chatterRoom.listeners.open === 1, 'the chat listener');

      chatterRoom.log.record(chatMessage({ message: 'before' }));

      await waitFor(() => client!.frames.some((sent) => sent.type === 'event'), 'the chat frame');

      signedIn = null;

      // A push loop would notice at its next pass; a message that arrives first must notice itself.
      chatterRoom.log.record(chatMessage({ message: 'after the logout' }));

      await waitFor(() => closing !== undefined, 'the signed-out close');

      assert.equal(closing!.code, 1008);
      assert.equal(closing!.reason, 'signed out');
      assert.ok(
        client.frames.every((sent) => messageOf(sent.data) !== 'after the logout'),
        `the signed-out socket still got a chat frame: ${JSON.stringify(client.frames)}`,
      );
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      // The signed-out close disposed the chat listener on its own.
      assert.equal(chatterRoom.listeners.open, 0);
      await close();
    }
  },
);

await test(
  'a socket whose viewer stays valid keeps being pushed while the session is re-checked every pass',
  { timeout: 20_000 },
  async () => {
    const logged: Array<string> = [];
    const signedIn: number | null = 1;
    let checks = 0;
    const { port, close } = await serving(
      depsOf(logged, {
        viewer: () => {
          checks += 1;

          return signedIn;
        },
      }),
    );
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('nearby', 's1'));

      await waitFor(() => client !== undefined && client.for('s1') >= 3, 'the pushed frames');

      assert.ok(checks >= 3, `the push loop re-checked the session only ${checks} times`);
      assert.ok(
        client.frames.every((frame) => frame.success === true),
        'a live session was answered with an error',
      );
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'a viewer dep that throws after the upgrade counts as signed out and closes the socket with 1008',
  { timeout: 20_000 },
  async () => {
    let signedIn = true;
    const deps = depsOf([], {
      viewer: () => {
        if (!signedIn) {
          throw new Error('the session store is gone');
        }

        return 1;
      },
    });
    const { port, close } = await serving(deps);
    let client: Client | undefined;
    let code = 0;

    try {
      client = await connected(port);
      client.socket.once('close', (closed: number) => {
        code = closed;
      });
      client.socket.send(subscribe('nearby', 's1'));

      await waitFor(() => client!.for('s1') >= 2, 'the pushed frames of a live session');

      signedIn = false;

      await waitFor(() => code !== 0, 'the signed-out close');

      assert.equal(code, 1008);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'a rider has at most maxConnectionsPerRider event sockets, and a seat comes back when one goes away',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    const clients: Array<Client> = [];

    try {
      for (let index = 0; index < maxConnectionsPerRider; index += 1) {
        clients.push(await connected(port));
      }

      assert.equal(maxConnectionsPerRider, clients.length);
      assert.equal(await rejectedUpgrade(port, {}), 429);

      await dropped(clients[0] ?? assert.fail('the first socket is there'));
      clients.shift();

      const again = await openedAtLast(port);

      clients.push(again);
      assert.equal(again.frames.length, 0);
    } finally {
      for (const client of clients) {
        client.socket.terminate();
      }

      await sleep(150);
      await close();
    }
  },
);

const broken = (): never => {
  throw new Error('the world is gone');
};

await test(
  'a world that cannot be read ends the socket with 1011 instead of pushing half a view',
  { timeout: 20_000 },
  async () => {
    const logged: Array<string> = [];
    const { port, close } = await serving(depsOf(logged, { view: broken }));
    let code = 0;
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.once('close', (closed: number) => {
        code = closed;
      });
      client.socket.send(subscribe('nearby', 's1'));

      await waitFor(() => code !== 0, 'the socket to be closed');

      assert.equal(code, 1011);
      assert.ok(logged.includes('widget_api.failed The widget push failed'));
    } finally {
      if (client !== undefined) {
        client.socket.terminate();
      }

      await close();
    }
  },
);

await test(
  'a client frame with a numeric uid and subId is answered, and its events carry that number',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(clientSubscribe('nearby', 1, 2));

      await waitFor(() => client !== undefined && client.frames.length >= 2, 'the answer and the first frame');

      const [answer, first] = client.frames;

      assert.ok(answer);
      assert.ok(first);

      // The client of the widget pages waits on this answer before it reads anything else.
      assert.deepEqual(answer, { type: 'response', uid: 1, success: true, data: null });

      assert.equal(first.success, true);
      assert.equal(first.type, 'event');
      assert.equal(first.uid, 2);

      // Its callbacks live in a map keyed by the number it asked with, so the number has to come back.
      assert.equal(typeof first.uid, 'number');

      const records = listOf(first.data);

      assert.equal(records.length, 2);

      for (const record of records) {
        assertNearbyV1(record);
      }

      await waitFor(() => client !== undefined && client.for(2) >= 3, 'two more pushed frames');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'an unsubscribe naming only its numeric subId is answered and stops that push',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(clientSubscribe('nearby', 1, 2));

      await waitFor(() => client !== undefined && client.for(2) >= 3, 'a few pushed frames');

      client.socket.send(clientUnsubscribe(3, 2));

      await waitFor(() => client !== undefined && client.for(3) > 0, 'the answer');

      assert.deepEqual(
        client.frames.find((frame) => frame.uid === 3),
        {
          type: 'response',
          uid: 3,
          success: true,
          data: null,
        },
      );

      await sleep(150);

      const settled = client.for(2);

      assert.ok(settled >= 3);

      await sleep(250);

      assert.equal(client.for(2), settled);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test('an unsubscribe naming a subId nobody holds is answered as a success', { timeout: 20_000 }, async () => {
  const { port, close } = await serving(depsOf([]));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(clientUnsubscribe(1, 99));

    await waitFor(() => client !== undefined && client.frames.length > 0, 'the answer');

    assert.deepEqual(client.frames, [{ type: 'response', uid: 1, success: true, data: null }]);
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    await close();
  }
});

await test(
  'a subscription the limit turns away answers its uid with an error and no event',
  { timeout: 20_000 },
  async () => {
    const logged: Array<string> = [];
    const { port, close } = await serving(depsOf(logged));
    let client: Client | undefined;

    try {
      client = await connected(port);

      for (let index = 1; index <= maxSubscriptions; index += 1) {
        client.socket.send(clientSubscribe('nearby', 100 + index, index));
      }

      await waitFor(
        () => client !== undefined && client.frames.filter((frame) => frame.type === 'event').length >= 16,
        'a first frame for every subscription',
      );

      for (let index = 1; index <= maxSubscriptions; index += 1) {
        assert.ok(client.for(index) > 0, `subscription ${index} got no frame`);
      }

      client.socket.send(clientSubscribe('nearby', 117, 17));

      await waitFor(() => client !== undefined && client.for(117) > 0, 'the refusal');

      assert.deepEqual(
        client.frames.find((frame) => frame.uid === 117),
        {
          type: 'response',
          uid: 117,
          success: false,
          error: 'too many subscriptions',
        },
      );
      assert.equal(client.for(17), 0);
      assert.ok(logged.includes('widget_api.limit A widget hit the subscription limit'));
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'a hand-written frame without a uid gets no answer and its string subId comes back untouched',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(subscribe('nearby', 's1'));

      await waitFor(() => client !== undefined && client.frames.length > 0, 'the first frame');

      // Exactly one frame: a sender that named no uid waits for no answer.
      assert.equal(client.frames.length, 1);
      assert.equal(client.frames[0]?.type, 'event');
      assert.equal(client.frames[0]?.uid, 's1');

      client.socket.send(unsubscribe('nearby'));
      await sleep(250);

      assert.ok(client.frames.every((frame) => frame.type === 'event'));
      assert.equal(client.for('s1'), 1);
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test('a request whose uid is no id at all is served without any answer', { timeout: 20_000 }, async () => {
  const { port, close } = await serving(depsOf([]));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(clientSubscribe('nearby', { nested: true }, 'x1'));

    await waitFor(() => client !== undefined && client.for('x1') > 0, 'the first frame');

    // The subscription works exactly as it does without a uid: no answer is sent to nobody.
    assert.equal(client.frames.length, 1);
    assert.equal(client.frames[0]?.type, 'event');
    assert.equal(client.frames[0]?.uid, 'x1');
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    await close();
  }
});

/** The failed answers of the HTTP RPC endpoints: every `error` must be the object the browser client
`makeRPCError` destructures, never a bare string. */
await test(
  'anonymous RPC answers the error envelope while an anonymous socket upgrade keeps its message body',
  { timeout: 20_000 },
  async () => {
    const anonymous = await serving(depsOf([], { viewer: () => null }));

    try {
      const rpc = await fetch(`http://127.0.0.1:${anonymous.port}/api/rpc/v2/getNearbyData`);

      assert.equal(rpc.status, 401);
      assert.deepEqual(await rpc.json(), {
        success: false,
        error: { name: 'AuthenticationError', message: 'Sign in first.', stack: '' },
      });

      assert.equal(await rejectedUpgrade(anonymous.port, {}), 401);

      // The guard of the event socket keeps its plain message body: asked over plain HTTP, the same
      // path answers `{ message: 'Sign in first.' }`, not the RPC error envelope. (Over a real
      // upgrade hono/node-server rejects with an empty body, so the body is checked without one.)
      const socketGuard = await fetch(`http://127.0.0.1:${anonymous.port}/api/ws/events`);

      assert.equal(socketGuard.status, 401);
      assert.deepEqual(await socketGuard.json(), { message: 'Sign in first.' });
    } finally {
      await anonymous.close();
    }
  },
);

await test(
  'a chat subscription answers only its acknowledgement and then one frame per message',
  { timeout: 20_000 },
  async () => {
    const talk = chatter();
    const { port, close } = await serving(depsOf([], {}, talk));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(clientSubscribe('chat', 7, 3));

      await waitFor(() => client!.frames.length > 0, 'the acknowledgement');
      await sleep(250);

      // The history comes from the getChatHistory RPC: an initial frame would be a bogus message.
      assert.equal(client.frames.length, 1);
      assert.deepEqual(client.frames[0], { type: 'response', uid: 7, success: true, data: null });

      const message = chatMessage({ message: 'hello' });

      talk.log.record(message);

      await waitFor(() => client!.frames.length > 1, 'the chat frame');
      await sleep(150);

      assert.equal(client.frames.length, 2);
      assert.deepEqual(client.frames[1], { success: true, type: 'event', uid: 3, data: message });
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test(
  'an unsubscribed chat listener stops and a closed socket hands its listener back',
  { timeout: 20_000 },
  async () => {
    const talk = chatter();
    const { port, close } = await serving(depsOf([], {}, talk));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(clientSubscribe('chat', 7, 3));

      await waitFor(() => talk.listeners.open === 1, 'the chat listener');

      client.socket.send(clientUnsubscribe(8, 3));

      await waitFor(() => talk.listeners.open === 0, 'the disposed chat listener');

      talk.log.record(chatMessage({ message: 'after' }));
      await sleep(150);

      // The acknowledgement of the subscription, the one of the unsubscribe, no event frame.
      assert.equal(client.frames.length, 2);
      assert.deepEqual(client.frames[1], { type: 'response', uid: 8, success: true, data: null });

      client.socket.send(clientSubscribe('chat', 9, 3));

      await waitFor(() => talk.listeners.open === 1, 'the re-subscribed chat listener');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }
    }

    // The socket died, so its listener has to be gone even though its subscription was live.
    assert.equal(talk.listeners.open, 0);
    await close();
  },
);

await test('re-subscribing the same subId leaves exactly one chat listener behind', { timeout: 20_000 }, async () => {
  const talk = chatter();
  const { port, close } = await serving(depsOf([], {}, talk));
  let client: Client | undefined;

  try {
    client = await connected(port);
    client.socket.send(clientSubscribe('chat', 7, 3));

    await waitFor(() => talk.listeners.open === 1, 'the first chat listener');

    client.socket.send(clientSubscribe('chat', 8, 3));

    await waitFor(() => client!.frames.length > 1, 'the second acknowledgement');

    // The old listener ended with the replaced subscription, so the count never goes above one.
    assert.equal(talk.listeners.open, 1);

    talk.log.record(chatMessage({ message: 'once' }));

    await waitFor(() => client!.frames.some((sent) => sent.type === 'event'), 'the chat frame');
    await sleep(150);

    assert.equal(client.frames.filter((sent) => sent.type === 'event').length, 1);
  } finally {
    if (client !== undefined) {
      await dropped(client);
    }

    assert.equal(talk.listeners.open, 0);
    await close();
  }
});

await test(
  'a chat listener delivers a direct message to its two riders and nobody else',
  { timeout: 20_000 },
  async () => {
    const talk = chatter();
    const { port, close } = await serving(depsOf([], {}, talk));
    let client: Client | undefined;

    try {
      client = await connected(port);
      client.socket.send(clientSubscribe('chat', 7, 3));

      await waitFor(() => talk.listeners.open === 1, 'the chat listener');

      talk.log.record(chatMessage({ from: 5, to: 7, message: 'not mine' }));
      talk.log.record(chatMessage({ from: 5, to: 1, message: 'to me' }));
      await sleep(150);

      const events = client.frames.filter((sent) => sent.type === 'event');

      assert.equal(events.length, 1);
      assert.deepEqual(messageOf(events[0]?.data), 'to me');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

const untouched = () => {
  throw new Error('no dep may be called');
};

await test('getFollowerAthletes answers the empty list without a call of any dep', { timeout: 20_000 }, async () => {
  const response = await post(
    depsOf([], { view: untouched, listenChat: untouched }),
    '/api/rpc/v1/getFollowerAthletes',
    [],
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, value: [] });
});

/** The `view` dep of the real wiring hands the world's Ride On counter to the view (see
`widgetApiRoutes`): a Ride On enqueued for a rider shows up in its record as `state.rideons`. */
await test('the view reports the ride ons the world counted for a rider', { timeout: 10_000 }, () => {
  const world = new World();

  // `enqueue` counts a Ride On by the attribute type alone; the payload is not read.
  world.enqueue(create(WorldAttributeSchema, { waType: WA_TYPE.WAT_RIDE_ON, payload: new Uint8Array() }), [2n]);

  const view = widgetView({
    watchingId: 1,
    states: [packet(1n, 1_000_000), packet(2n, 1_005_000)],
    stats: () => {},
    profile: () => identity,
    rideOns: (id) => world.rideOns.count(id),
  });

  assert.equal(view.byId.get(2)?.state.rideons, 1);
  assert.equal(view.byId.get(1)?.state.rideons, 0);
});

await test(
  'a socket holds at most maxSubscriptions and re-asking one of them is free',
  { timeout: 20_000 },
  async () => {
    const { port, close } = await serving(depsOf([]));
    let client: Client | undefined;

    try {
      client = await connected(port);

      for (let index = 1; index <= 16; index += 1) {
        client.socket.send(subscribe('nearby', `s${index}`));
      }

      await waitFor(
        () =>
          client !== undefined &&
          client.frames.filter((frame) => typeof frame.uid === 'string' && frame.uid.startsWith('s')).length >= 16,
        'a first frame for every subscription',
      );

      for (let index = 1; index <= 16; index += 1) {
        assert.ok(client.for(`s${index}`) > 0, `subscription s${index} got no frame`);
      }

      client.socket.send(subscribe('nearby', 's17'));
      await sleep(250);

      assert.equal(client.for('s17'), 0);

      // The same `subId` replaces what it stood for instead of being turned away.
      const before = client.for('s3');

      client.socket.send(subscribe('groups/v2', 's3'));

      await waitFor(() => client !== undefined && client.for('s3') > before, 'the replaced subscription');
    } finally {
      if (client !== undefined) {
        await dropped(client);
      }

      await close();
    }
  },
);

await test('getJSON is refused 501 as a GET and as a POST, and 401 to nobody', { timeout: 20_000 }, async () => {
  const deps = depsOf([]);

  for (const response of [
    await get(deps, `/api/rpc/v2/getJSON/${arg('/athlete/1')}`),
    await post(deps, '/api/rpc/v1/getJSON', ['http://evil.example']),
    await post(deps, '/api/rpc/v1/getJSON', []),
  ]) {
    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { name: 'NotSupportedError', message: 'getJSON is not available on this server', stack: '' },
    });
  }

  const anonymous = await post(depsOf([], { viewer: () => null }), '/api/rpc/v1/getJSON', ['/athlete/1']);

  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {
    success: false,
    error: { name: 'AuthenticationError', message: 'Sign in first.', stack: '' },
  });
});

await test(
  'getVersion answers zluggish, so a version-gated widget feature simply stays off',
  { timeout: 20_000 },
  async () => {
    const version = await get(depsOf([]), '/api/rpc/v2/getVersion');

    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { success: true, value: 'zluggish' });
  },
);

/** The HTTP status of one answer of the API. */
const statusOf = async (answer: Response | Promise<Response>) => {
  const response = await answer;

  return response.status;
};

await test(
  'a setting is stored by a POST of this site and read back with its default',
  { timeout: 20_000 },
  async () => {
    const deps = depsOf([]);

    assert.equal(await statusOf(get(deps, `/api/rpc/v2/setSetting/${arg('theme')}/${arg('dark')}`)), 405);
    assert.deepEqual(
      await answerOf(await get(deps, `/api/rpc/v2/getSetting/${arg('theme')}/${arg('light')}`), Schema.String),
      {
        success: true,
        value: 'light',
      },
    );

    assert.equal(await statusOf(post(deps, '/api/rpc/v1/setSetting', ['theme', 'dark'])), 200);
    assert.deepEqual(
      await answerOf(await get(deps, `/api/rpc/v2/getSetting/${arg('theme')}/${arg('light')}`), Schema.String),
      {
        success: true,
        value: 'dark',
      },
    );

    assert.equal(await statusOf(post(deps, '/api/rpc/v1/setSetting', ['../theme', 'dark'])), 400);
    assert.equal(
      await statusOf(post(depsOf([], { originAllowed: () => false }), '/api/rpc/v1/setSetting', ['theme', 'x'])),
      403,
    );
  },
);

await test('updateAthleteData merges an object and refuses anything else', { timeout: 20_000 }, async () => {
  const deps = depsOf([]);

  await post(deps, '/api/rpc/v1/updateAthleteData', [2, { laps: 1, name: 'a' }]);

  const merged = await answerOf(
    await post(deps, '/api/rpc/v1/updateAthleteData', [2, { laps: 2, name: null }]),
    Schema.Record(Schema.String, Schema.Unknown),
  );

  assert.deepEqual(merged.value, { laps: 2 });
  assert.equal(await statusOf(post(deps, '/api/rpc/v1/updateAthleteData', [2, [1, 2]])), 400);
  assert.equal(await statusOf(post(deps, '/api/rpc/v1/updateAthleteData', ['nobody', {}])), 400);
});

await test('mod changes are for an administrator of this site only', { timeout: 20_000 }, async () => {
  const deps = depsOf([]);

  assert.deepEqual(await answerOf(await get(deps, '/api/rpc/v2/getAvailableMods'), Schema.Array(Schema.Unknown)), {
    success: true,
    value: [],
  });

  for (const [name, args] of [
    ['setModEnabled', ['some-mod', true, 'hash']],
    ['removeMod', ['some-mod']],
    ['installModFromGitHub', ['owner/repo']],
    ['installModFromZip', ['UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==']],
  ] as const) {
    assert.equal(await statusOf(post(deps, `/api/rpc/v1/${name}`, args)), 403, name);
  }

  assert.equal(await statusOf(get(deps, '/api/rpc/v2/getModStore')), 403);

  const admin = depsOf([], { isAdministrator: () => true });

  assert.equal(await statusOf(post(admin, '/api/rpc/v1/setModEnabled', ['some-mod', true])), 400);
  assert.equal(await statusOf(post(admin, '/api/rpc/v1/setModEnabled', ['some-mod', true, 'hash'])), 400);
  assert.equal(await statusOf(post(admin, '/api/rpc/v1/installModFromGitHub', ['not a repo'])), 400);
  assert.equal(await statusOf(post(admin, '/api/rpc/v1/installModFromZip', [''])), 400);
  const foreign = depsOf([], { isAdministrator: () => true, originAllowed: () => false });

  assert.equal(await statusOf(post(foreign, '/api/rpc/v1/removeMod', ['x'])), 403);
});
