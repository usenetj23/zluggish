import { DocumentsService } from '#src/services/documents.service';
import { responseStatus, inputValue } from '#tests/support/html';
import type { createGameApp } from '#src/http/app';
import { createCdn } from '#src/node/network/cdn';
import { DeliveryRefusedError } from '#src/errors';
import { UploadsService } from '#src/services/uploads.service';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { FeatureRequestSchema, FeatureResponseSchema } from '#src/protocol/generated/variants_pb';
import { runtimeFixture } from '#tests/support/runtime';
import { mediumWeb } from '#tests/medium/support';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { Schema } from 'effect';

function browser(app: ReturnType<typeof createGameApp>) {
  let cookie = '';
  let csrf = '';

  const client = {
    get csrf() {
      return csrf;
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookie);
      const response = await app.request(path, { ...init, headers });
      const set = response.headers.getSetCookie().at(-1);

      if (set) {
        cookie = set.split(';', 1)[0] ?? '';
      }

      return response;
    },
    async form(path: string, fields: Record<string, string>) {
      return client.request(path, {
        method: 'POST',
        body: new URLSearchParams({ ...fields, csrf_token: csrf }),
      });
    },
    async signIn(player: number, username: string) {
      const response1 = await client.request('/login/');
      const picker = await response1.text();
      csrf = inputValue(picker, 'csrf_token') ?? '';
      await client.form('/login/', { player_id: String(player), step: 'password', password: 'test-password' });

      // Signing in starts a fresh browser session with its own CSRF token.
      const response2 = await client.request(`/user/${username}/`);
      const home = await response2.text();
      csrf = inputValue(home, 'csrf_token') ?? '';
    },
  };

  return client;
}

await test('Strava credentials are stored encrypted, never echoed, and disconnecting removes them', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Strava Rider', 'test-password');
  const web = mediumWeb(f, user);

  const saved = await web.request('/api/me/connections/strava', 'PUT', {
    username: '12345',
    secret: 'very-secret-value',
  });

  assert.equal(saved.status, 200);
  assert.doesNotMatch(await saved.text(), /very-secret-value/);

  assert.deepEqual(f.accounts.repositories.connectionsRepository.read(user.player_id, 'strava'), [
    '12345',
    'very-secret-value',
  ]);

  const empty = await web.request('/api/me/connections/strava', 'PUT', { username: '', secret: '' });
  assert.equal(empty.status, 400);
  await web.request('/api/me/connections/strava/cookie', 'PUT', { cookie: 'cookie-value' });
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.text(user.player_id, 'strava4_session.txt'))),
    'cookie-value',
  );
  const stored = f.accounts.db.prepare("SELECT data FROM rider_document WHERE name='strava4_session.txt'").get();
  assert.equal(
    Buffer.from(Schema.decodeUnknownSync(Schema.instanceOf(Uint8Array))(stored?.data)).includes('cookie-value'),
    false,
  );
  const removed = await web.request('/api/me/connections/strava', 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(user.player_id, 'strava4_session.txt'))),
    false,
  );
  assert.equal(f.accounts.repositories.connectionsRepository.read(user.player_id, 'strava'), null);
});

function activityWithFit() {
  return create(ActivitySchema, {
    id: 99n,
    playerId: 1n,
    name: 'Tempo',
    startDate: '2026-05-01T06:00:00Z',
    fit: Uint8Array.from([1, 2, 3]),
    fitFilename: 'ride.fit',
  });
}

function stubFetch(t: TestContext) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];

  t.mock.method(globalThis, 'fetch', (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });

    return Promise.resolve(
      Response.json({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: 9e9,
      }),
    );
  });

  return calls;
}

for (const athlete of ['42', 'i42']) {
  await test(`Intervals.icu upload for athlete ${athlete} pairs and removes only the planned workout`, async (t) => {
    const f = runtimeFixture(t);
    const user = await f.accounts.create('Interval Rider', 'test-password');
    f.accounts.repositories.connectionsRepository.save(user.player_id, 'intervals', [athlete, 'key']);
    const folder = f.profiles.folder(user.player_id);
    const cached = resolve(f.config.storageDir, 'tp-workouts/intervalsicu');
    mkdirSync(cached, { recursive: true });
    const first = '7c2b7f55-1f5e-4a3e-8a5e-0f1f4b7a1a11';
    const second = '8d3c8f66-2a6f-4b4f-9b6f-1a2a5c8b2b22';
    writeFileSync(resolve(cached, `${first}.zwo`), '<a/>');
    writeFileSync(resolve(cached, `${second}.zwo`), '<a/>');

    writeFileSync(
      resolve(folder, 'intervals_icu_workout.json'),
      JSON.stringify({
        provider: 'intervals-icu',
        workouts: [
          {
            provider: 'intervals-icu',
            event_id: 5,
            workout_id: first,
            name: 'Tempo',
            start_date_local: '2026-05-01T07:00:00',
            filename: `${first}.zwo`,
          },
          {
            provider: 'intervals-icu',
            event_id: 6,
            workout_id: second,
            name: 'Evening',
            start_date_local: '2026-05-01T18:00:00',
          },
        ],
      }),
    );

    const calls = stubFetch(t);
    await f.effects.runPromise(UploadsService.use((service) => service.intervals(user.player_id, activityWithFit())));

    const upload = calls.find((call) => call.url.includes('intervals.icu'));
    assert.ok(upload);
    assert.equal(new URL(upload.url).pathname, `/api/v1/athlete/${athlete}/activities`);
    assert.equal(new URL(upload.url).search, '?name=Tempo&paired_event_id=5');
    assert.equal(upload.headers.get('Authorization'), `Basic ${Buffer.from('API_KEY:key').toString('base64')}`);

    const remaining = Schema.decodeUnknownSync(
      Schema.Struct({ workouts: Schema.Array(Schema.Struct({ event_id: Schema.Finite })) }),
    )(JSON.parse(readFileSync(resolve(folder, 'intervals_icu_workout.json'), 'utf8')));

    assert.deepEqual(
      remaining.workouts.map((item) => item.event_id),
      [6],
    );
    assert.equal(existsSync(resolve(cached, `${first}.zwo`)), false);
    assert.equal(existsSync(resolve(cached, `${second}.zwo`)), true);
  });
}

await test('an expired Strava token is saved before an upload whose result is unknown', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Upload Rider', 'test-password');
  f.effects.runSync(
    DocumentsService.use((service) => service.put(user.player_id, 'strava_token.txt', '1\nsecret\nold\nrefresh\n1\n')),
  );
  f.effects.runSync(
    DocumentsService.use((service) => service.put(user.player_id, 'runalyze_token.txt', 'runalyze-token\n')),
  );
  const calls: Array<string> = [];

  t.mock.method(globalThis, 'fetch', (input: URL | string) => {
    calls.push(String(input));

    if (String(input).includes('/api/v3/uploads')) {
      return Promise.reject(new Error('offline'));
    }

    return Promise.resolve(
      Response.json({
        access_token: 'new',
        refresh_token: 'newer',
        expires_at: 9e9,
      }),
    );
  });

  const uploads = f.effects.runSync(UploadsService);
  await assert.rejects(
    f.effects.runPromise(uploads.strava(user.player_id, activityWithFit())),
    (error) => !(error instanceof DeliveryRefusedError),
  );
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.text(user.player_id, 'strava_token.txt'))),
    '1\nsecret\nnew\nnewer\n9000000000\n',
  );
  await f.effects.runPromise(uploads.runalyze(user.player_id, activityWithFit()));
  assert.ok(calls.some((url) => url.includes('runalyze.com')));
});

await test('game app has no server operations even for the first legacy owner', async (t) => {
  const f = runtimeFixture(t);
  const owner = await f.accounts.create('Owner', 'test-password');
  const client = browser(f.app);
  await client.signIn(owner.player_id, owner.username);

  for (const path of ['/restart', '/cancelrestart', '/reloadbots']) {
    assert.equal(await responseStatus(client.form(path, { confirm_action: 'on' })), 404);
  }
});

await test('per-rider variants override the base set and unknown names stay explicit', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Variant Rider', 'test-password');

  writeFileSync(
    resolve(f.profiles.folder(user.player_id), 'variants.txt'),
    JSON.stringify({ variants: [{ name: 'custom_flag', value: true }] }),
  );

  const client = browser(f.app);
  await client.signIn(user.player_id, user.username);

  const response = await client.request('/experimentation/v1/variant', {
    method: 'POST',
    body: toBinary(
      FeatureRequestSchema,
      create(FeatureRequestSchema, {
        params: [{ param: ['custom_flag', 'missing'] }],
      }),
    ),
  });

  const decoded = fromBinary(FeatureResponseSchema, new Uint8Array(await response.arrayBuffer()));

  assert.deepEqual(
    decoded.variants.map((item) => [item.name, item.value]),
    [
      ['custom_flag', true],
      ['missing', false],
    ],
  );
  const response8 = await f.app.request('/experimentation/v1/variant', { method: 'POST' });
  assert.equal(response8.status, 401);
});

await test('launcher assets are served safely and game assets redirect to the CDN', async (t) => {
  const f = runtimeFixture(t);
  const style = await f.app.request('/style/site.css');
  assert.equal(style.status, 200);
  assert.equal(style.headers.get('Content-Type'), 'text/css');
  assert.match(await style.text(), /background-image: url\('\/style\/background.jpg'\)/);
  const background = await f.app.request('/style/background.jpg');
  assert.equal(background.status, 200);
  assert.equal(background.headers.get('Content-Type'), 'image/jpeg');
  const traversal = await f.app.request('/static/%2e%2e/%2e%2e/tokens.json');
  assert.equal(traversal.status, 404);
  const response9 = await f.app.request('/style/%2e%2e/%2e%2e/README.md');
  assert.equal(response9.status, 404);
  const response10 = await f.app.request('/mochi/watopian/missing.json');
  assert.equal(response10.status, 404);

  const redirect = await f.app.request('/gameassets/Game.xml');
  assert.equal(redirect.status, 302);
  // eslint-disable-next-line unicorn/prefer-https -- The launcher must redirect to the HTTP CDN listener.
  assert.equal(redirect.headers.get('Location'), 'http://cdn.zwift.com/gameassets/Game.xml');
});

await test('the game API and CDN both serve the launcher loading page and its assets', async (t) => {
  const f = runtimeFixture(t);
  const env = { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 12_345, remoteFamily: 'IPv4' } } };

  for (const [app, origin] of [
    [f.app, 'https://launcher.zwift.com'],
    // eslint-disable-next-line unicorn/prefer-https -- The Windows launcher requests this page over HTTP.
    [createCdn(f), 'http://cdn.zwift.com'],
  ] as const) {
    const loading = await app.request(`${origin}/static/web/launcher/embed.html`, undefined, env);
    assert.equal(loading.status, 200, origin);
    assert.match(loading.headers.get('Content-Type')!, /^text\/html; charset=utf-8$/i);
    const loadingHtml = await loading.text();
    assert.match(loadingHtml, /Loading Zwift/);
    assert.match(loadingHtml, /Please star us on GitHub/);
    assert.match(loadingHtml, /class="wordmark[^"]*">zluggish/);
    assert.doesNotMatch(loadingHtml, /bootstrap|\/style\/site\.css/);

    for (const extension of ['css', 'js']) {
      const asset = new RegExp(String.raw`"(/static/launcher-ui/[^"]+\.${extension})"`).exec(loadingHtml)?.[1];
      assert.ok(asset, `Missing launcher ${extension} in ${origin}`);
      const response = await app.request(origin + asset, undefined, env);
      assert.equal(response.status, 200, origin + asset);
      await response.arrayBuffer();
    }
  }
});

await test('mochi files stream in full and by byte range', async (t) => {
  const f = runtimeFixture(t);
  const folder = resolve(f.config.storageDir, 'mochi/watopian');
  const data = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);

  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, 'segment'), data);
  writeFileSync(resolve(folder, 'empty'), '');

  const full = await f.app.request('/mochi/watopian/segment');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(full.headers.get('Content-Length'), '300000');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), data);

  const part = await f.app.request('/mochi/watopian/segment', { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 1000-1999/300000');
  assert.equal(part.headers.get('Content-Length'), '1000');
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), data.slice(1000, 2000));

  const open = await f.app.request('/mochi/watopian/segment', { headers: { Range: 'bytes=299990-' } });
  assert.equal(open.status, 206);
  assert.deepEqual(new Uint8Array(await open.arrayBuffer()), data.slice(299_990));

  const suffix = await f.app.request('/mochi/watopian/segment', { headers: { Range: 'bytes=-10' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('Content-Range'), 'bytes 299990-299999/300000');

  const beyond = await f.app.request('/mochi/watopian/segment', { headers: { Range: 'bytes=300000-' } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('Content-Range'), 'bytes */300000');

  const ignored = await f.app.request('/mochi/watopian/segment', { headers: { Range: 'bytes=0-1,5-6' } });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.headers.get('Content-Length'), '300000');
  await ignored.arrayBuffer();

  const empty = await f.app.request('/mochi/watopian/empty');
  assert.equal(empty.status, 200);
  const emptyBody = await empty.arrayBuffer();
  assert.equal(emptyBody.byteLength, 0);
});

await test('the mobile aggregate composes goals, activities, events and invitations', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Mobile Rider', 'test-password');

  const response = await f.app.request(
    '/relay/worlds/1/aggregate/mobile?goalCount=2&activityCount=2&eventCount=1&eventSport=CYCLING&pendingEventInviteCount=1&acceptedEventInviteCount=1',
    {
      headers: {
        Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
      },
    },
  );

  assert.equal(response.status, 200);

  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      events: Schema.Array(Schema.Struct({ sport: Schema.Literal('CYCLING') })).check(Schema.isMaxLength(1)),
      goals: Schema.Array(Schema.Json),
      activities: Schema.Array(Schema.Json),
      pendingPrivateEventFeed: Schema.Array(Schema.Json),
      acceptedPrivateEventFeed: Schema.Array(Schema.Json),
      worldName: Schema.Literal('MAKURIISLANDS'),
      playerCount: Schema.Literal(0),
    }),
  )(await response.json());

  assert.equal(body.events.length, 1);
  assert.equal(body.goals.length, 0);
});

await test('Strava authorization only completes for the web session that started it', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('OAuth Rider', 'test-password');
  const web = mediumWeb(f, user);
  f.accounts.repositories.connectionsRepository.save(user.player_id, 'strava', ['55', 'secret']);
  const calls = stubFetch(t);
  const start = await web.request('/api/me/connections/strava/authorize', 'POST', {});
  const { url } = await start.json();
  const target = new URL(url);
  assert.equal(target.searchParams.get('client_id'), '55');
  const state = target.searchParams.get('state')!;
  const other = mediumWeb(f, user);
  const refused = await other.request('/api/me/connections/strava/authorize', 'POST', { code: 'abc', state });
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(user.player_id, 'strava_token.txt'))),
    false,
  );
  const accepted = await web.request('/api/me/connections/strava/authorize', 'POST', { code: 'abc', state });
  assert.equal(accepted.status, 200);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.text(user.player_id, 'strava_token.txt'))),
    '55\nsecret\na\nr\n9000000000\n',
  );
});
