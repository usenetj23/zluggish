import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { create } from '@bufbuild/protobuf';
import { Schema } from 'effect';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import { ActivitiesService } from '#src/services/activities.service';
import { ClimbRecorderService } from '#src/services/climb-recorder.service';
import { DocumentsService } from '#src/services/documents.service';
import { parseClimbEfforts } from '#src/world/climb-efforts';
import { parseClimbProfiles } from '#src/world/climb-profile';
import { FIT_EPOCH_S } from '#src/world/climb-ride';
import type { Sample } from '#src/world/climb-ride';
import { WORLD_TIME_EPOCH_MS } from '#src/world/state';
import { binary, mediumFixture } from '#tests/medium/support';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));
const T0 = 2_000_000;
const ROAD = 10_052;

/** A 1 Hz recording of a 1200 s climb of 5900 m gaining 376 m, between a warm-up and a cool-down. */
const recording: Sample[] = Array.from({ length: 1500 }, (_, i) => {
  const onClimb = Math.max(0, Math.min(i, 1300) - 100);

  return {
    timestamp: T0 + i,
    distance: i * 0.5 + onClimb * (5900 / 1200 - 0.5),
    altitude: 13 + onClimb * (376 / 1200),
    power: 240,
    heartRate: 150,
  };
});

async function activityWithClimb(f: Awaited<ReturnType<typeof mediumFixture>>, finishOffsetS = 0) {
  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Climb',
    startDate: new Date().toISOString(),
    distanceInMeters: 9000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(await response.json());

  await f.effects.runPromise(
    ActivitiesService.use((activities) => activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }))),
  );

  // The game saves the result when the climb ends (sample 1300); its clock may differ from the recording's.
  const worldTime = (T0 + FIT_EPOCH_S + 1300 + finishOffsetS) * 1000 - WORLD_TIME_EPOCH_MS;

  f.accounts.db
    .prepare('INSERT INTO route_result(player_id,route_hash,world_time,elapsed_ms,activity_id) VALUES (?,?,?,?,?)')
    .run(f.rider.player_id, ROAD, worldTime, 1_200_000, id);

  return id;
}

const climbs = (elevationM: number) => new Map([[String(ROAD), { distanceM: 5900, elevationM }]]);

await test('a climb ride of an activity is learned with its statistics and its profile', async (t) => {
  const f = await mediumFixture(t);
  t.mock.method(FitDecoder.prototype, 'decode', () => ({ records: recording }));

  const id = await activityWithClimb(f, 40);

  const learned = await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.rider.player_id, id, climbs(376))),
  );

  assert.equal(learned, 1);

  const effortsText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_efforts.json')),
  );

  const efforts = parseClimbEfforts(effortsText ?? '');
  const effort = efforts[String(ROAD)]?.at(0);

  assert.ok(effort);
  assert.equal(effort.elapsedMs, 1_200_000);
  assert.equal(effort.avgPowerW, 240);
  assert.equal(effort.startedAt, new Date((T0 + 100 + FIT_EPOCH_S) * 1000).toISOString());

  const profilesText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_profiles.json')),
  );

  const profile = parseClimbProfiles(profilesText ?? '')[String(ROAD)];

  assert.ok(profile);
  assert.ok(Math.abs(profile.distanceM - 5900) < 60);
});

await test('the same ride is not added twice and an existing profile is kept', async (t) => {
  const f = await mediumFixture(t);
  t.mock.method(FitDecoder.prototype, 'decode', () => ({ records: recording }));

  const id = await activityWithClimb(f);

  await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.rider.player_id, id, climbs(376))),
  );

  const first = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_profiles.json')),
  );

  await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.rider.player_id, id, climbs(376))),
  );

  const effortsText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_efforts.json')),
  );

  const efforts = parseClimbEfforts(effortsText ?? '');

  assert.equal(efforts[String(ROAD)]?.length, 1);

  const second = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_profiles.json')),
  );

  assert.equal(second, first);
});

await test('a recording whose altitude does not fit the climb gives the ride but no profile', async (t) => {
  const f = await mediumFixture(t);
  t.mock.method(FitDecoder.prototype, 'decode', () => ({ records: recording }));

  const id = await activityWithClimb(f);

  const learned = await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.rider.player_id, id, climbs(63))),
  );

  assert.equal(learned, 1);

  const effortsText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_efforts.json')),
  );

  assert.equal(parseClimbEfforts(effortsText ?? '')[String(ROAD)]?.length, 1);

  const profilesText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_profiles.json')),
  );

  assert.deepEqual(parseClimbProfiles(profilesText ?? ''), {});
});

await test('an activity of another rider and one without climb results learn nothing', async (t) => {
  const f = await mediumFixture(t);
  const id = await activityWithClimb(f);

  const otherLearned = await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.other.player_id, id, climbs(376))),
  );

  assert.equal(otherLearned, 0);

  f.accounts.db.prepare('DELETE FROM route_result').run();
  t.mock.method(FitDecoder.prototype, 'decode', () => ({ records: recording }));

  const noResultLearned = await f.effects.runPromise(
    ClimbRecorderService.use((recorder) => recorder.record(f.rider.player_id, id, climbs(376))),
  );

  assert.equal(noResultLearned, 0);

  const effortsText = await f.effects.runPromise(
    DocumentsService.use((documents) => documents.text(f.rider.player_id, 'climb_efforts.json')),
  );

  assert.equal(effortsText, null);
});
