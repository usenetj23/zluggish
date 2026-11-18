import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { GarminRepository } from '#src/repositories/garmin.repository';
import { UploadsService } from '#src/services/uploads.service';
import { mediumFixture } from '#tests/medium/support';
import { Decoder, Stream } from '@garmin/fitsdk';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

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
