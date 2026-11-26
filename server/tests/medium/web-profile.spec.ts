import { WebSessionsService } from '#src/services/web-session.service';
import { Effect } from 'effect';
import { IntegrationsService } from '#src/services/integrations.service';
import { ConnectionsService } from '#src/services/connections.service';
import { DocumentsService } from '#src/services/documents.service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { createWebApp } from '#src/http/web-app';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { responseStatus } from '#tests/support/html';
import { mediumFixture } from '#tests/medium/support';

const upload = () => {
  const data = new FormData();
  data.set(
    'profile.bin',
    new File(
      [toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Imported', totalXp: 500 }))],
      'profile.bin',
    ),
  );

  return data;
};

async function json(input: Response | Promise<Response>): Promise<any> {
  const response = await input;

  return response.json();
}

await test('web imports isolate staged data, require CSRF and source confirmation, and preserve local identity', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const sessions = f.effects.runSync(WebSessionsService);
  const owner = f.effects.runSync(sessions.create(f.accounts.identityOf(f.rider)));
  const other = f.effects.runSync(sessions.create(f.accounts.identityOf(f.other)));

  const request = (path: string, method = 'GET', data?: FormData | Record<string, string | boolean>, session = owner) =>
    web.request(`http://local:8080${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${session.id}`,
        Origin: 'http://local:8080',
        'X-CSRF-Token': session.session.csrf,
        ...(!(data instanceof FormData) && { 'Content-Type': 'application/json' }),
      },
      ...(data && { body: data instanceof FormData ? data : JSON.stringify(data) }),
    });

  assert.equal(await responseStatus(web.request('http://local:8080/api/me/import')), 401);
  assert.equal(
    await responseStatus(web.request('http://local:8080/api/me/import', { method: 'POST', body: upload() })),
    403,
  );
  const staged = await request('/api/me/import', 'POST', upload());
  assert.equal(staged.status, 200);
  const { review } = await staged.json();
  assert.equal(review.sourceId, '999');
  const otherState = await json(request('/api/me/import', 'GET', undefined, other));
  assert.equal(otherState.review, null);
  assert.equal(
    await responseStatus(
      request('/api/me/import/confirm', 'POST', { stage: review.stage, confirmSource: true }, other),
    ),
    409,
  );
  assert.equal(
    await responseStatus(request('/api/me/import/confirm', 'POST', { stage: review.stage, cancel: true })),
    200,
  );
  assert.equal(f.accounts.get(f.rider.player_id)?.first_name, f.rider.first_name);
  const again = await json(request('/api/me/import', 'POST', upload()));
  assert.equal(
    await responseStatus(request('/api/me/import/confirm', 'POST', { stage: review.stage, confirmSource: true })),
    409,
  );
  assert.equal(again.review.confirmSource, false);
  assert.equal(
    await responseStatus(request('/api/me/import/confirm', 'POST', { stage: again.review.stage, confirmSource: true })),
    200,
  );
  assert.equal(f.accounts.get(f.rider.player_id)?.first_name, 'Imported');
  assert.equal(f.profiles.get(f.rider.player_id).id, BigInt(f.rider.player_id));
  assert.equal(f.profiles.get(f.rider.player_id).totalXp, 500);
  assert.equal(f.accounts.get(f.rider.player_id)?.auth_version, f.rider.auth_version);
  assert.equal(await responseStatus(request('/profile-data')), 200);
  assert.equal(await responseStatus(request('/zwift')), 200);
});

await test('web Zwift credentials stay encrypted and downloaded data waits for review', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);

  const { id, session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const request = (path: string, method = 'GET', data?: Record<string, string | boolean>) =>
    web.request(`http://local:8080${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${id}`,
        Origin: 'http://local:8080',
        'X-CSRF-Token': session.csrf,
        'Content-Type': 'application/json',
      },
      ...(data && { body: JSON.stringify(data) }),
    });

  assert.equal(
    await responseStatus(request('/api/me/zwift', 'PUT', { username: '', password: '', upload: true, click: false })),
    400,
  );

  const saved = await request('/api/me/zwift', 'PUT', {
    username: 'official-user',
    password: 'official-secret',
    upload: true,
    click: true,
  });

  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { connected: true, upload: true, click: true });
  assert.deepEqual(f.effects.runSync(ConnectionsService.use((service) => service.read(f.rider.player_id, 'zwift'))), [
    'official-user',
    'official-secret',
  ]);
  assert.equal(
    Buffer.from(
      f.effects.runSync(DocumentsService.use((service) => service.get(f.rider.player_id, 'zwift_credentials.bin')))!,
    ).includes(Buffer.from('official-secret')),
    false,
  );
  t.mock.method(f.effects.runSync(IntegrationsService), 'downloadOfficialData', () =>
    Effect.succeed({ 'achievements.bin': new Uint8Array() }),
  );
  const downloaded = await request('/api/me/zwift/import', 'POST', { profile: false, achievements: true });
  assert.equal(downloaded.status, 200);
  const downloadBody = await json(downloaded);
  assert.deepEqual(downloadBody.review.files, ['achievements.bin']);
  assert.equal(downloadBody.review.confirmSource, true);
  assert.equal(
    await responseStatus(request('/api/me/import/confirm', 'POST', { stage: downloadBody.review.stage })),
    400,
  );
  assert.equal(
    f.effects.runSync(DocumentsService.use((service) => service.has(f.rider.player_id, 'achievements.bin'))),
    false,
  );
  assert.equal(await responseStatus(request('/api/me/zwift', 'DELETE', {})), 200);
  assert.equal(f.effects.runSync(ConnectionsService.use((service) => service.has(f.rider.player_id, 'zwift'))), false);
});

await test('web exports only the signed-in rider data and power curve changes require confirmation', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);

  const { id, session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const data = new Uint8Array([1, 2, 3]);
  f.effects.runSync(DocumentsService.use((service) => service.put(f.rider.player_id, 'streaks.bin', data)));

  const request = (path: string, method = 'GET', body?: Record<string, string | boolean>) =>
    web.request(`http://local:8080${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${id}`,
        Origin: 'http://local:8080',
        'X-CSRF-Token': session.csrf,
        'Content-Type': 'application/json',
      },
      ...(body && { body: JSON.stringify(body) }),
    });

  assert.equal(await responseStatus(web.request('http://local:8080/api/me/export/streaks.bin')), 401);
  const list = await request('/api/me/export');
  const exported: { filenames: Array<string> } = await list.json();
  assert.ok(exported.filenames.includes('streaks.bin'));
  const download = await request('/api/me/export/streaks.bin');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition') ?? '', /streaks.bin/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), data);
  assert.equal(await responseStatus(request('/api/me/export/zwift_credentials.bin')), 400);
  assert.equal(await responseStatus(request('/api/me/power-curves', 'POST', { confirm: false, create: false })), 400);
  assert.equal(await responseStatus(request('/api/me/power-curves', 'POST', { confirm: true, create: false })), 200);
});
