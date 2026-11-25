import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFixture } from '#tests/support/runtime';
import { mediumWeb } from '#tests/medium/support';

/**
The Overlay opt-in API (`src/http/routes/overlay.ts`): `GET /api/me/overlay` answers the current state
of the signed-in rider (off by default) and `PUT /api/me/overlay` turns it on or off. The `/api/*`
middleware of `web-app.ts` enforces the session and, for a mutating method, the same origin and the
CSRF header before the handler ever runs, so an anonymous or token-less PUT never reaches the store.
*/

const json = { 'Content-Type': 'application/json' };

await test(
  'the overlay opt-in defaults to off, round trips through PUT and survives as a file',
  { timeout: 30_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const rider = await f.accounts.create('Overlay Rider', 'test-password');
    const web = mediumWeb(f, rider);

    const off = await web.request('/api/me/overlay');

    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { enabled: false });

    const on = await web.request('/api/me/overlay', 'PUT', { enabled: true });

    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { enabled: true });

    const answer1 = await web.request('/api/me/overlay');

    assert.deepEqual(await answer1.json(), { enabled: true });

    const written: unknown = JSON.parse(readFileSync(join(f.config.storageDir, 'overlay-optin.json'), 'utf8'));

    assert.deepEqual(written, { [String(rider.player_id)]: true });

    const back = await web.request('/api/me/overlay', 'PUT', { enabled: false });

    assert.deepEqual(await back.json(), { enabled: false });
    assert.deepEqual(JSON.parse(readFileSync(join(f.config.storageDir, 'overlay-optin.json'), 'utf8')), {});
  },
);

await test('a body that is not exactly `{ enabled: boolean }` is refused with 400', { timeout: 30_000 }, async (t) => {
  const f = runtimeFixture(t);
  const web = mediumWeb(f, await f.accounts.create('Overlay Rider', 'test-password'));

  for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }, { missing: true }]) {
    const response = await web.request('/api/me/overlay', 'PUT', body);

    assert.equal(response.status, 400, JSON.stringify(body));
  }

  // A JSON array and a JSON string are no object at all; they go up as raw bytes.
  for (const body of ['[true]', '"true"']) {
    const response = await web.request('/api/me/overlay', 'PUT', new TextEncoder().encode(body));

    assert.equal(response.status, 400, body);
  }

  const answer2 = await web.request('/api/me/overlay');

  assert.deepEqual(await answer2.json(), { enabled: false });
});

await test('another rider is not affected by the opt-in of the first one', { timeout: 30_000 }, async (t) => {
  const f = runtimeFixture(t);
  const first = f.accounts.create('First Rider', 'test-password');
  const other = await f.accounts.create('Second Rider', 'test-password');
  const firstWeb = mediumWeb(f, await first);
  const second = mediumWeb(f, other);

  const answer3 = await firstWeb.request('/api/me/overlay', 'PUT', { enabled: true });

  assert.deepEqual(await answer3.json(), { enabled: true });

  const answer4 = await second.request('/api/me/overlay');

  assert.deepEqual(await answer4.json(), { enabled: false });

  const anonymous = {
    request: (path: string, init: RequestInit = {}) => firstWeb.app.request(`http://local:8080${path}`, init),
  };

  const anonymousPut = await anonymous.request('/api/me/overlay', {
    method: 'PUT',
    headers: { ...json, Origin: 'http://local:8080' },
    body: JSON.stringify({ enabled: true }),
  });

  assert.ok(anonymousPut.status === 401 || anonymousPut.status === 403, `anonymous PUT: ${anonymousPut.status}`);

  const anonymousGet = await anonymous.request('/api/me/overlay');

  assert.equal(anonymousGet.status, 401, 'anonymous GET needs a session');
  assert.equal(
    JSON.parse(readFileSync(join(f.config.storageDir, 'overlay-optin.json'), 'utf8'))[String(other.player_id)],
    undefined,
    'an anonymous PUT must not opt anybody in',
  );
});

await test(
  'a mutating request without the CSRF header is refused before the handler runs',
  { timeout: 30_000 },
  async (t) => {
    const f = runtimeFixture(t);
    const web = mediumWeb(f, await f.accounts.create('Overlay Rider', 'test-password'));

    const noToken = await web.app.request('http://local:8080/api/me/overlay', {
      method: 'PUT',
      headers: { ...json, Origin: 'http://local:8080', Cookie: 'zluggish_web_session=nope' },
      body: JSON.stringify({ enabled: true }),
    });

    assert.equal(noToken.status, 403);
  },
);
