import { WebSessionsService } from '#src/services/web-session.service';
import { UploadsService } from '#src/services/uploads.service';
import { WorkoutsService } from '#src/services/workout.service';
import { Effect } from 'effect';
import { IntegrationsService } from '#src/services/integrations.service';
import { ConnectionsService } from '#src/services/connections.service';
import { DocumentsService } from '#src/services/documents.service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebApp } from '#src/http/web-app';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { responseStatus } from '#tests/support/html';
import { mediumFixture, mediumWeb } from '#tests/medium/support';

await test('web connections require web authentication and CSRF, isolate riders and hide secrets', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);

  const owner = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const request = (path: string, method = 'GET', data?: Record<string, string>, csrf = owner.session.csrf) =>
    app.request(`https://web.example${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${owner.id}`,
        Origin: 'https://web.example',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      ...(data && { body: JSON.stringify(data) }),
    });

  assert.equal(await responseStatus(app.request('/api/me/connections')), 401);
  assert.equal(
    await responseStatus(
      request('/api/me/connections/garmin', 'PUT', { username: 'athlete', secret: 'private-password' }, 'wrong'),
    ),
    403,
  );

  for (const provider of ['strava', 'garmin', 'intervals']) {
    assert.equal(
      await responseStatus(
        request(`/api/me/connections/${provider}`, 'PUT', { username: '12345', secret: 'private-password' }),
      ),
      200,
    );
    assert.equal(
      await responseStatus(request(`/api/me/connections/${provider}`, 'PUT', { username: '12345', secret: '' })),
      200,
    );
  }

  assert.equal(
    await responseStatus(
      request('/api/me/connections/intervals', 'PUT', { username: ' i12345 ', secret: 'private-password' }),
    ),
    200,
  );
  assert.deepEqual(
    f.effects.runSync(ConnectionsService.use((service) => service.read(f.rider.player_id, 'intervals'))),
    ['i12345', 'private-password'],
  );
  assert.equal(
    await responseStatus(
      request('/api/me/connections/intervals', 'PUT', { username: 'abc', secret: 'private-password' }),
    ),
    400,
  );

  assert.equal(
    await responseStatus(request('/api/me/connections/strava/cookie', 'PUT', { cookie: 'private-cookie' })),
    200,
  );
  const response = await request('/api/me/connections');
  const body = await response.text();
  assert.ok(!body.includes('private-password'));
  assert.ok(!body.includes('private-cookie'));
  assert.equal(JSON.parse(body).strava.cookie, true);
  assert.equal(JSON.parse(body).intervals.username, 'i12345');
  assert.deepEqual(f.effects.runSync(ConnectionsService.use((service) => service.read(f.rider.player_id, 'garmin'))), [
    '12345',
    'private-password',
  ]);
  assert.equal(f.effects.runSync(ConnectionsService.use((service) => service.read(f.other.player_id, 'garmin'))), null);
  const authorizationResponse = await request('/api/me/connections/strava/authorize', 'POST', {});
  const authorization = await authorizationResponse.json();
  const url = new URL(authorization.url);
  assert.equal(url.origin, 'https://www.strava.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://web.example/integrations');
  assert.notEqual(url.searchParams.get('state'), owner.session.csrf);
  assert.equal(
    await responseStatus(request('/api/me/connections/strava/authorize', 'POST', { code: 'code', state: 'wrong' })),
    403,
  );
  assert.equal(await responseStatus(request('/api/me/connections/strava', 'DELETE')), 200);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(f.rider.player_id, 'strava4_session.txt'))),
    false,
  );
  assert.equal(f.effects.runSync(ConnectionsService.use((service) => service.has(f.rider.player_id, 'strava'))), false);
  f.effects.runSync(WebSessionsService.use((sessions) => sessions.end(owner.id)));
  assert.equal(await responseStatus(request('/api/me/connections')), 401);
});

await test('web Strava authorization consumes state and rejects a completion after sign-out', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);

  const owner = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  f.effects.runSync(
    ConnectionsService.use((service) => service.save(f.rider.player_id, 'strava', ['client', 'secret'])),
  );

  const post = (data: Record<string, string>) =>
    app.request('https://web.example/api/me/connections/strava/authorize', {
      method: 'POST',
      headers: {
        Cookie: `zluggish_web_session=${owner.id}`,
        Origin: 'https://web.example',
        'X-CSRF-Token': owner.session.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

  const started = await post({});
  const { url } = await started.json();
  const state = new URL(url).searchParams.get('state')!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(f.accounts.repositories.stravaRepository, 'exchangeCode', async () => {
    entered.resolve();
    await release.promise;

    return {
      clientId: 'client',
      clientSecret: 'secret',
      access: 'access',
      refresh: 'refresh',
      expiresAt: 9_999_999_999,
    };
  });
  const pending = post({ code: 'code', state });
  await entered.promise;
  assert.equal(await responseStatus(post({ code: 'code', state })), 403);
  f.effects.runSync(WebSessionsService.use((sessions) => sessions.end(owner.id)));
  release.resolve();
  assert.equal(await responseStatus(pending), 400);
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(f.rider.player_id, 'strava_token.txt'))),
    false,
  );
});

await test('web uploads, workout sync and Strava session tests stay with the signed-in user', async (t) => {
  const f = await mediumFixture(t);
  const web = mediumWeb(f, f.rider);
  const anonymous = createWebApp(f);

  // Without a session, reads are unauthorized and writes already fail the CSRF check.
  for (const [path, method, expected] of [
    ['/api/me/uploads', 'GET', 401],
    ['/api/me/uploads/retry', 'POST', 403],
    ['/api/me/workouts/sync', 'POST', 403],
    ['/api/me/connections/strava/test', 'POST', 403],
  ] as const) {
    assert.equal(await responseStatus(anonymous.request(`http://local:8080${path}`, { method })), expected, path);
  }

  const status = t.mock.method(f.effects.runSync(UploadsService), 'status', (id: number) => {
    assert.equal(id, f.rider.player_id);

    return Effect.succeed(
      Array.from({ length: 150 }, (_, index) => ({
        activity_id: index,
        provider: 'strava',
        state: 'failed',
        last_error: null,
      })),
    );
  });

  const listed = await web.request('/api/me/uploads');
  const { jobs } = await listed.json();
  assert.equal(jobs.length, 100);
  assert.equal(status.mock.callCount(), 1);
  const retry = t.mock.method(f.effects.runSync(UploadsService), 'retry', () => Effect.void);
  assert.equal(await responseStatus(web.request('/api/me/uploads/retry', 'POST', {})), 200);
  assert.equal(await responseStatus(web.request('/api/me/uploads/retry', 'POST', { ambiguous: true })), 200);
  assert.deepEqual(
    retry.mock.calls.map((call) => call.arguments),
    [
      [f.rider.player_id, false],
      [f.rider.player_id, true],
    ],
  );

  assert.equal(await responseStatus(web.request('/api/me/connections/strava/test', 'POST', {})), 400);
  f.effects.runSync(
    DocumentsService.use((service) => service.put(f.rider.player_id, 'strava4_session.txt', 'session-cookie\nignored')),
  );
  const check = t.mock.method(f.effects.runSync(IntegrationsService), 'checkSession', () => Effect.succeed(false));
  const tested = await web.request('/api/me/connections/strava/test', 'POST', {});
  assert.deepEqual(await tested.json(), { valid: false });
  assert.equal(check.mock.calls[0]?.arguments[0], 'session-cookie');

  // Strava rotates the session cookie; the newest value replaces the stored one.
  const rotateCookie = check.mock.calls[0]?.arguments[1];
  assert.ok(rotateCookie);
  rotateCookie('rotated-cookie');
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.text(f.rider.player_id, 'strava4_session.txt'))),
    'rotated-cookie',
  );
  check.mock.mockImplementation(() => Effect.die(new Error('offline')));
  assert.equal(await responseStatus(web.request('/api/me/connections/strava/test', 'POST', {})), 503);

  // With both providers configured, the one the user syncs becomes the game's provider.
  f.effects.runSync(ConnectionsService.use((service) => service.save(f.rider.player_id, 'intervals', ['42', 'key'])));
  f.settings.save(f.rider.player_id, { 'workouts.trainingpeaks.bridgeFolder': '/missing-folder' });
  assert.equal(
    f.effects.runSync(WorkoutsService.use((service) => service.provider(f.rider.player_id))),
    'intervals-icu',
  );
  const synced = await web.request('/api/me/workouts/sync', 'POST', { provider: 'trainingpeaks' });
  assert.deepEqual(await synced.json(), { message: 'TrainingPeaks bridge folder is missing.' });
  assert.equal(
    f.effects.runSync(WorkoutsService.use((service) => service.provider(f.rider.player_id))),
    'trainingpeaks',
  );
  assert.equal(f.effects.runSync(WorkoutsService.use((service) => service.provider(f.other.player_id))), null);
  assert.equal(await responseStatus(web.request('/api/me/workouts/sync', 'POST', { provider: 'garmin' })), 400);
});

await test('web riders remove one stored credential and keep the rest', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);

  const owner = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const connections = f.effects.runSync(ConnectionsService);
  const documents = f.effects.runSync(DocumentsService);

  const remove = (path: string, csrf = owner.session.csrf) =>
    responseStatus(
      app.request(`https://web.example/api/me/connections/${path}`, {
        method: 'DELETE',
        headers: {
          Cookie: `zluggish_web_session=${owner.id}`,
          Origin: 'https://web.example',
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
      }),
    );

  for (const rider of [f.rider, f.other]) {
    f.effects.runSync(connections.save(rider.player_id, 'strava', ['12345', 'client-secret']));
    f.effects.runSync(connections.save(rider.player_id, 'garmin', ['athlete', 'password']));
    f.effects.runSync(documents.put(rider.player_id, 'strava_token.txt', 'token'));
    f.effects.runSync(documents.put(rider.player_id, 'strava4_session.txt', 'cookie'));
    f.effects.runSync(documents.put(rider.player_id, 'garth/oauth1_token.json', '{}'));
    f.effects.runSync(documents.put(rider.player_id, 'garth/oauth2_token.json', '{}'));
  }

  const stored = () => [
    f.effects.runSync(connections.has(f.rider.player_id, 'strava')),
    f.effects.runSync(documents.has(f.rider.player_id, 'strava_token.txt')),
    f.effects.runSync(documents.has(f.rider.player_id, 'strava4_session.txt')),
    f.effects.runSync(connections.has(f.rider.player_id, 'garmin')),
    f.effects.runSync(documents.has(f.rider.player_id, 'garth/oauth1_token.json')),
    f.effects.runSync(documents.has(f.rider.player_id, 'garth/oauth2_token.json')),
  ];

  assert.equal(await remove('strava/cookie', 'wrong'), 403);
  assert.equal(await remove('strava/cookie'), 200);
  assert.deepEqual(stored(), [true, true, false, true, true, true]);
  assert.equal(await remove('strava/authorization'), 200);
  assert.deepEqual(stored(), [true, false, false, true, true, true]);
  assert.equal(await remove('garmin/authorization'), 200);
  assert.deepEqual(stored(), [true, false, false, true, false, false]);
  assert.equal(await remove('strava/api'), 200);
  assert.equal(await remove('garmin/credentials'), 200);
  assert.deepEqual(stored(), [false, false, false, false, false, false]);
  assert.equal(await remove('intervals/cookie'), 400);
  assert.equal(await remove('strava/encryption_key'), 400);

  assert.equal(f.effects.runSync(connections.has(f.other.player_id, 'strava')), true);
  assert.equal(f.effects.runSync(documents.has(f.other.player_id, 'strava4_session.txt')), true);
  assert.equal(f.effects.runSync(documents.has(f.other.player_id, 'garth/oauth2_token.json')), true);
});

await test('unexpected web failures are logged with their stack trace', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);

  const owner = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const error = t.mock.method(f.world.lifecycle.log, 'error', () => {});

  t.mock.method(f.effects.runSync(ConnectionsService), 'inspect', () => {
    throw new Error('connections unreadable');
  });

  const response = await app.request('https://web.example/api/me/connections', {
    headers: { Cookie: `zluggish_web_session=${owner.id}` },
  });

  assert.equal(response.status, 500);
  assert.equal(error.mock.callCount(), 1);
  const [event, , fields] = error.mock.calls[0]!.arguments;
  assert.equal(event, 'web.failed');
  assert.equal(fields?.route, '/api/me/connections');
  assert.ok(fields?.error instanceof Error);
  assert.equal(fields.error.message, 'connections unreadable');
});

await test('credentials written with another key ask the rider to enter them again', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);

  const owner = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const crypto = new CryptoRepository();
  const warn = t.mock.method(f.world.lifecycle.log, 'warn', () => {});

  f.effects.runSync(
    DocumentsService.use((service) =>
      service.put(
        f.rider.player_id,
        'garmin_credentials.bin',
        crypto.encryptCredentials(crypto.randomBytes(32), ['athlete', 'old-password']),
      ),
    ),
  );

  const request = (path: string, method = 'GET', data?: Record<string, string>) =>
    app.request(`https://web.example${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${owner.id}`,
        Origin: 'https://web.example',
        'X-CSRF-Token': owner.session.csrf,
        'Content-Type': 'application/json',
      },
      ...(data && { body: JSON.stringify(data) }),
    });

  const response = await request('/api/me/connections');

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.garmin, {
    username: '',
    saved: true,
    unreadable: true,
    authorized: false,
  });
  assert.equal(warn.mock.calls[0]?.arguments[0], 'connections.unreadable');

  // The secret cannot be kept, so it must be entered again.
  assert.equal(
    await responseStatus(request('/api/me/connections/garmin', 'PUT', { username: 'athlete', secret: '' })),
    400,
  );
  assert.equal(
    await responseStatus(request('/api/me/connections/garmin', 'PUT', { username: 'athlete', secret: 'new' })),
    200,
  );
  assert.deepEqual(f.effects.runSync(ConnectionsService.use((service) => service.read(f.rider.player_id, 'garmin'))), [
    'athlete',
    'new',
  ]);
  const fixed = await request('/api/me/connections');
  const repaired = await fixed.json();

  assert.equal(repaired.garmin.unreadable, false);
});
