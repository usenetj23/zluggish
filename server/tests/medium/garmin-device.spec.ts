import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { createWebApp } from '#src/http/web-app';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { defaultSerial } from '#src/world/fit-device';
import { UploadsService } from '#src/services/uploads.service';
import { mediumFixture } from '#tests/medium/support';
import { Decoder, Stream } from '@garmin/fitsdk';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';

const fit = new Uint8Array(readFileSync(new URL('../fixtures/ride.fit', import.meta.url)));

const activity = create(ActivitySchema, { name: 'Ride', fit, fitFilename: 'ride.fit' });

const named = (bytes: Uint8Array) => {
  const { messages } = new Decoder(Stream.fromByteArray([...bytes])).read({ convertTypesToStrings: false });

  return (messages.fileIdMesgs ?? []).map((message) => [message.manufacturer, message.product]);
};

/** A rider with Garmin authorization; the files that reach Garmin Connect are collected. */
async function garmin(t: TestContext, device?: string) {
  const f = await mediumFixture(t);
  f.services.documents.put(f.rider.player_id, 'garth/oauth1_token.json', '{}');

  if (device !== undefined) f.services.documents.put(f.rider.player_id, 'garmin_device.txt', device);
  const sent: Uint8Array[] = [];

  const collect = (...call: Parameters<GarminRepository['uploadGarmin']>) => {
    sent.push(call[3]);

    return Promise.resolve();
  };

  t.mock.method(GarminRepository.prototype, 'uploadGarmin', collect);

  return { f, sent };
}

await test('the activity reaches Garmin Connect as recorded on the device of garmin_device.txt', async (t) => {
  const { f, sent } = await garmin(t, 'manufacturer=1\nproduct=3843\nserial=1234567890\n');

  await new UploadsService(f).garmin(f.rider.player_id, activity);

  assert.equal(sent.length, 1);
  assert.deepEqual(named(sent[0] ?? new Uint8Array()), [[1, 3843]]);
  assert.deepEqual(activity.fit, fit, 'the activity itself keeps the file of the game');
});

await test('without a device, or with one that cannot be read, the file of the game is sent as it is', async (t) => {
  for (const device of [undefined, 'serial=abc']) {
    const { f, sent } = await garmin(t, device);

    await new UploadsService(f).garmin(f.rider.player_id, activity);
    assert.deepEqual(sent, [fit]);
  }
});

type DeviceInput = Record<string, string | number>;

/** The web app as a signed-in rider: a request with the session, the origin and the CSRF token of a write. */
async function webRider(t: TestContext) {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const { id } = f.services.management.sessions.create(f.accounts.identityOf(f.rider));
  const cookie = `zluggish_web_session=${id}`;
  const me = await web.request('http://local:8080/api/me', { headers: { Cookie: cookie } });
  const { csrf } = z.object({ csrf: z.string() }).parse(await me.json());

  const send = (method: string, path: string, body?: DeviceInput) => {
    const init: RequestInit = {
      method,
      headers: {
        Cookie: cookie,
        Origin: 'http://local:8080',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
    };

    if (body !== undefined) init.body = JSON.stringify(body);

    return web.request(`http://local:8080${path}`, init);
  };

  const garmin = z.object({
    device: z.unknown(),
    devices: z.array(z.object({ product: z.number(), name: z.string() })),
  });

  const status = async (method: string, path: string, body?: DeviceInput) => {
    const response = await send(method, path, body);

    return response.status;
  };

  const garminState = async () => {
    const response = await send('GET', '/api/me/connections/garmin/device');

    return garmin.parse(await response.json());
  };

  return { f, status, garminState };
}

await test('a rider chooses the Garmin device in the web app, keeps the serial number, and can remove it', async (t) => {
  const { f, status, garminState } = await webRider(t);
  const player = f.rider.player_id;
  const stored = () => f.services.documents.text(player, 'garmin_device.txt');
  const path = '/api/me/connections/garmin/device';

  const start = await garminState();
  assert.equal(start.device, null);
  assert.deepEqual(start.devices[0], { product: 3843, name: 'Edge 1040' });
  assert.equal(start.devices.length, 9);

  assert.equal(await status('PUT', path, { product: 3843 }), 200);
  assert.equal(
    stored(),
    `manufacturer=1\nproduct=3843\nserial=${defaultSerial(player)}\n`,
    'a serial number of the rider',
  );
  const chosen = await garminState();
  assert.deepEqual(chosen.device, { manufacturer: 1, product: 3843, serial: defaultSerial(player) });

  await status('PUT', path, { product: 4440, serial: 12_345 });
  assert.equal(stored(), 'manufacturer=1\nproduct=4440\nserial=12345\n');

  await status('PUT', path, { product: 3122 });
  assert.equal(stored(), 'manufacturer=1\nproduct=3122\nserial=12345\n', 'the serial number is kept');

  assert.equal(await status('DELETE', path), 200);
  assert.equal(stored(), null);
  const removed = await garminState();
  assert.equal(removed.device, null);
});

await test('the Garmin device is refused with a product or serial number out of range, or anything else in it', async (t) => {
  const { f, status } = await webRider(t);

  const refused: DeviceInput[] = [
    { product: 0 },
    { product: 70_000 },
    { product: 3843, serial: 0 },
    { product: 3843, serial: 4_294_967_296 },
    { product: 3843, manufacturer: 255 },
    { product: 'Edge' },
    {},
  ];

  for (const body of refused) {
    const code = await status('PUT', '/api/me/connections/garmin/device', body);
    assert.equal(code, 400, JSON.stringify(body));
  }

  assert.equal(f.services.documents.text(f.rider.player_id, 'garmin_device.txt'), null);
});

await test('a file that cannot be given the device is sent as it is, with a warning', async (t) => {
  const { f, sent } = await garmin(t, 'manufacturer=1\nproduct=3843\nserial=1234567890\n');
  const warnings: string[] = [];
  const broken = create(ActivitySchema, { name: 'Ride', fit: new Uint8Array([1, 2, 3]), fitFilename: 'ride.fit' });

  const warn = (message: string) => {
    warnings.push(message);
  };

  await new UploadsService(f, warn).garmin(f.rider.player_id, broken);

  assert.deepEqual(sent, [new Uint8Array([1, 2, 3])]);
  assert.equal(warnings.length, 1);
});
