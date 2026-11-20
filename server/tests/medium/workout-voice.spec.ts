import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { create } from '@bufbuild/protobuf';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { VoiceService } from '#src/services/voice.service';
import { WorkoutsService } from '#src/services/workout.service';
import { Effect } from 'effect';
import { mediumFixture } from '#tests/medium/support';

const ID = '84e16aa6-2e13-4cc5-9bea-76595a66abe0';

const ZWO = `<workoutFile>
  <Name>Tempo</Name>
  <Sections>
    <Section name="Main" repeats="1">
      <Block type="steady" time="300" targetPowerPct="80" />
    </Section>
  </Sections>
</workoutFile>`;

/** The workout file is cached and the voice records who it is read to. */
async function setup(t: TestContext) {
  const f = await mediumFixture(t);
  const file = await f.effects.runPromise(WorkoutsService.use((workouts) => workouts.file(ID)));

  assert.ok(file);
  new AssetFiles().writeDurable(file, ZWO);

  const voice = f.effects.runSync(VoiceService);
  const spoken = t.mock.method(voice, 'onWorkout', () => Effect.void);

  const path = `/tp-workouts/intervalsicu/${ID}.zwo`;

  // Without a rider the request carries no identity, as the game's workout file request often does.
  const asked = (rider?: typeof f.rider) => (rider ? f.request(path, {}, rider) : f.app.request(path));

  return { f, spoken, asked };
}

await test('a workout file without identity is read to nobody while several riders are online', async (t) => {
  const { f, spoken, asked } = await setup(t);

  f.world.online.set(BigInt(f.rider.player_id), create(PlayerStateSchema));
  f.world.online.set(BigInt(f.other.player_id), create(PlayerStateSchema));

  const response = await asked();

  assert.equal(response.status, 200);
  assert.equal(spoken.mock.callCount(), 0);
});

await test('a workout file without identity is read to the only rider who is online', async (t) => {
  const { f, spoken, asked } = await setup(t);

  f.world.online.set(BigInt(f.rider.player_id), create(PlayerStateSchema));

  const response = await asked();

  assert.equal(response.status, 200);
  assert.equal(spoken.mock.callCount(), 1);
  assert.equal(spoken.mock.calls.at(0)?.arguments.at(0), f.rider.player_id);
});

await test('a workout file with identity is read to the rider who asked, not to the others online', async (t) => {
  const { f, spoken, asked } = await setup(t);

  f.world.online.set(BigInt(f.rider.player_id), create(PlayerStateSchema));
  f.world.online.set(BigInt(f.other.player_id), create(PlayerStateSchema));

  const response = await asked(f.other);

  assert.equal(response.status, 200);
  assert.equal(spoken.mock.callCount(), 1);
  assert.equal(spoken.mock.calls.at(0)?.arguments.at(0), f.other.player_id);
});

await test('a workout file is read to nobody when nobody is online', async (t) => {
  const { spoken, asked } = await setup(t);

  const response = await asked();

  assert.equal(response.status, 200);
  assert.equal(spoken.mock.callCount(), 0);
});
