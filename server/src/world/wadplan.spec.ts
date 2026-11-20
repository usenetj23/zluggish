import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexWadWorkouts, parseWadWorkout } from '#src/world/wadplan';

const XML = `
<workout_file>
    <uniqueId>u-1</uniqueId>
    <legacyIdHash>123</legacyIdHash>
    <name>Test &amp; Fire</name>
    <workout>
        <Warmup Duration="60" PowerLow=".65" PowerHigh=".80">
            <textevent timeoffset="0" message="Welcome &apos;home&apos;." locIndex="1" />
        </Warmup>
        <IntervalsT Repeat="2" OnDuration="30" OffDuration="30" OnPower=".90" OffPower=".70">
            <textevent timeoffset="30" message="Ease off." locIndex="2" />
        </IntervalsT>
        <Cooldown Duration="60" Power=".5" />
    </workout>
</workout_file>`;

await test('zwift native workout parses into speakable blocks', () => {
  const workout = parseWadWorkout(XML);

  assert.ok(workout);
  assert.equal(workout.plan.name, 'Test & Fire');
  assert.equal(workout.plan.totalSeconds, 240);
  assert.deepEqual(
    workout.plan.blocks.map((block) => [block.name, block.durationSeconds]),
    [
      // The game counts every on and every off of a set of intervals as a segment of its own.
      ['Warmup', 60],
      ['Intervals on', 30],
      ['Intervals off', 30],
      ['Intervals on', 30],
      ['Intervals off', 30],
      ['Cooldown', 60],
    ],
  );
  assert.deepEqual(workout.plan.blocks[1]?.power, { format: 'ftp', low: 90, high: 90 });
  assert.deepEqual(workout.plan.blocks[2]?.power, { format: 'ftp', low: 70, high: 70 });
  assert.deepEqual(workout.cues, [
    { at: 0, message: "Welcome 'home'." },
    { at: 90, message: 'Ease off.' },
  ]);
});

await test('the index answers with both ids the client log prints', () => {
  const index = indexWadWorkouts([{ name: 'Workouts/One.xml', data: new TextEncoder().encode(XML) }]);

  assert.equal(index.get('123')?.plan.name, 'Test & Fire');
  assert.equal(index.get('u-1')?.id, '123');
});
