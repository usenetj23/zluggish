import { Effect, Schema } from 'effect';
import { WorkoutsService } from '#src/services/workout.service';
import { ConnectionsService } from '#src/services/connections.service';
import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('Svelte SSR dashboard keeps identity, CSRF and static asset boundaries', async (t) => {
  const f = await mediumFixture(t);
  const unauthorized = await f.app.request(`/user/${f.rider.username}/`);
  assert.equal(unauthorized.status, 401);
  const browser = await mediumBrowser(f);
  const page = await browser.request(`/user/${f.rider.username}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  const html = await page.text();
  assert.match(html, /Start Zwift/);
  assert.match(html, /name="csrf_token"/);

  const props = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(
    JSON.parse(/id="launcher-props">([^<]+)<\/script>/.exec(html)![1]!),
  );

  assert.ok(props.csrf);
  const asset = /src="(\/static\/launcher-ui\/[^"]+\.js)"/.exec(html)![1]!;
  const script = await f.app.request(asset);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('Content-Type'), 'text/javascript');
  assert.match(script.headers.get('Cache-Control')!, /immutable/);
  assert.equal(script.headers.get('Set-Cookie'), null);

  for (const path of [
    '/static/launcher-ui/missing.js',
    '/static/launcher-ui/.vite/manifest.json',
    '/static/launcher-ui/assets/%2e%2e%2f.vite%2fmanifest.json',
  ]) {
    const missing = await f.app.request(path);
    assert.equal(missing.status, 404);
  }
});

await test('the launcher links to the web app only when enabled with a public URL', async (t) => {
  const url = 'https://zwift.example.org:8443';

  for (const { publicUrl, enabled, expected } of [
    { publicUrl: url, enabled: true, expected: url },
    { publicUrl: null, enabled: true, expected: null },
    { publicUrl: url, enabled: false, expected: null },
  ]) {
    const f = await mediumFixture(t, publicUrl, enabled);
    const browser = await mediumBrowser(f);

    for (const path of ['/login/', `/user/${f.rider.username}/`]) {
      const response = await browser.request(path);
      const html = await response.text();
      const link = html.includes('class="web-app');
      assert.equal(link, expected !== null, path);

      if (expected) {
        assert.match(html, /<a class="web-app[^"]*" href="https:\/\/zwift\.example\.org:8443"/);
      }

      const props = Schema.decodeUnknownSync(Schema.Struct({ webApp: Schema.NullOr(Schema.String) }))(
        JSON.parse(/id="launcher-props">([^<]+)<\/script>/.exec(html)![1]!),
      );

      assert.equal(props.webApp, expected);
    }
  }
});

await test('the launcher no longer serves the pages that moved to the web app', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const { username } = f.rider;

  for (const path of [
    `/settings/${username}/`,
    `/reset/${username}/`,
    `/zwift/${username}/`,
    `/strava/${username}/`,
    `/garmin/${username}/`,
    `/intervals/${username}/`,
    `/trainingpeaks/${username}/`,
    `/power_curves/${username}/`,
    `/profile/${username}/`,
    `/profile/${username}/confirm/`,
    '/strava_auth',
    '/authorization',
    '/garmin_auth',
    '/ui/status/uploads',
  ]) {
    const response = await browser.request(path);
    assert.equal(response.status, 404, path);
  }

  for (const path of ['/download', '/delete/strava_token.txt', `/intervals/${username}/sync`]) {
    const response = await browser.form(path);
    assert.equal(response.status, 404, path);
  }
});

await test('serialized props and SSR escape user content', async (t) => {
  const f = await mediumFixture(t);
  f.accounts.repository.updateImportedProfile(f.rider.player_id, '</script><script>evil()</script>&', 'Rider', 1);
  const browser = await mediumBrowser(f);
  const page = await browser.request(`/user/${f.rider.username}/`);
  const html = await page.text();
  assert.ok(!html.includes('</script><script>evil()'));
  assert.match(html, /\\u003c/);
});

await test('session probes never create anonymous sessions or trigger workout sync', async (t) => {
  const f = await mediumFixture(t);
  const before = f.sessions.browsers.size;
  const anonymous = await f.app.request('/ui/status/session', { headers: { Accept: 'application/json' } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('Set-Cookie'), null);
  assert.equal(f.sessions.browsers.size, before);

  const browser = await mediumBrowser(f);
  const sync = t.mock.method(f.effects.runSync(WorkoutsService), 'syncWorkoutsAutomatically', () => Effect.void);
  const live = await browser.request('/ui/status/session', { headers: { Accept: 'application/json' } });
  assert.equal(live.status, 204);
  assert.equal(live.headers.get('Cache-Control'), 'no-store');
  assert.equal(sync.mock.callCount(), 0);
});

await test('JSON form posts return redirects and reject expired tokens and stale contexts', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const page = await browser.request(`/user/${f.rider.username}/`);

  const props = Schema.decodeUnknownSync(Schema.Struct({ csrf: Schema.String }))(
    JSON.parse(/id="launcher-props">([^<]+)<\/script>/.exec(await page.text())![1]!),
  );

  const post = (csrf: string, context = props.csrf) =>
    browser.request('/riders/switch/', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Game-Context': context },
      body: new URLSearchParams({ csrf_token: csrf }),
    });

  const expired = await post('expired');
  assert.equal(expired.status, 400);
  const { reload: expiredReload } = await expired.json();
  assert.equal(expiredReload, true);
  const stale = await post(props.csrf, 'another-rider-context');
  assert.equal(stale.status, 409);
  const { reload: staleReload } = await stale.json();
  assert.equal(staleReload, true);
  const switched = await post(props.csrf);
  assert.equal(switched.status, 200);
  assert.deepEqual(await switched.json(), { ok: true, data: {}, redirectTo: '/login/' });
});

await test('browser JSON errors do not change game API responses and never serialize saved secrets', async (t) => {
  const f = await mediumFixture(t);
  const game = await f.app.request('/api/profiles/me', { headers: { Accept: 'application/json' } });
  assert.equal(game.status, 401);
  assert.ok(!game.headers.get('Content-Type')?.includes('application/json'));
  f.effects.runSync(
    ConnectionsService.use((service) =>
      service.save(f.rider.player_id, 'garmin', ['public-user', 'never-send-garmin-password']),
    ),
  );
  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'strava', ['123', 'never-send-client-secret'])),
  );
  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'intervals', ['42', 'never-send-api-key'])),
  );
  f.effects.runSync(
    ConnectionsService.use((service) =>
      service.save(f.rider.player_id, 'zwift', ['zwift-user', 'never-send-zwift-password']),
    ),
  );
  t.mock.method(f.effects.runSync(WorkoutsService), 'syncWorkoutsAutomatically', () => Effect.void);
  const browser = await mediumBrowser(f);

  for (const path of ['/login/', `/user/${f.rider.username}/`]) {
    const page = await browser.request(path);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.includes('never-send-'));
  }
});
