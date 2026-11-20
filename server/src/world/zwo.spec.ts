import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '#src/world/zwo';

const ZWO = `<workoutFile>
  <Name>Sweet 2x12</Name>
  <Zone>Sweet Spot</Zone>
  <Sections>
    <Section name="Warmup" repeats="1">
      <Block type="steady" time="300" targetPowerPct="50" />
      <Block type="ramp" time="300" lowPct="50" highPct="70" />
    </Section>
    <Section name="Main" repeats="2">
      <Block type="steady" time="720" lowWatts="268" highWatts="280" cadence="92" />
      <Block type="steady" time="300" targetPowerPct="0" />
    </Section>
    <Section name="Sprint lead-out" repeats="1">
      <Block type="steady" distance="400" />
    </Section>
    <Section name="Cooldown" repeats="1">
      <Block type="steady" time="600" targetPowerWatts="150" />
      <Block type="lap" time="60" />
    </Section>
  </Sections>
</workoutFile>`;

await test('sections repeat one block per repetition, as the game numbers them', () => {
  const plan = parsePlan(ZWO);

  assert.ok(plan);
  assert.equal(plan.name, 'Sweet 2x12');
  assert.equal(plan.blocks.length, 8);
  assert.deepEqual(
    plan.blocks.map((block) => [block.name, block.durationSeconds]),
    [
      ['Warmup', 300],
      ['Warmup', 300],
      ['Main 1/2', 720],
      ['Main 1/2', 300],
      ['Main 2/2', 720],
      ['Main 2/2', 300],
      ['Sprint lead-out', null],
      ['Cooldown', 600],
    ],
  );
  assert.equal(plan.blocks.at(-1)?.name, 'Cooldown');
  assert.equal(plan.blocks.at(-1)?.durationSeconds, 600);
  assert.equal(plan.totalSeconds, 300 + 300 + (720 + 300) * 2 + 600);
});

await test('powers keep their format, range and cadence; rests and free blocks lose the target', () => {
  const plan = parsePlan(ZWO);

  assert.ok(plan);
  assert.deepEqual(plan.blocks[1]?.power, { format: 'ftp', low: 50, high: 70 });
  assert.deepEqual(plan.blocks[2]?.power, { format: 'watts', low: 268, high: 280 });
  assert.equal(plan.blocks[2]?.cadence, 92);
  assert.equal(plan.blocks[3]?.power, null);
  assert.equal(plan.blocks[6]?.power, null);
  assert.equal(plan.blocks[6]?.meters, 400);
});

await test('a single section or block parses without arrays', () => {
  const plan = parsePlan(
    '<workoutFile><Name>One</Name><Sections><Section name="Go"><Block type="steady" time="60" targetPowerWatts="200"/></Section></Sections></workoutFile>',
  );

  assert.ok(plan);
  assert.equal(plan.blocks.length, 1);
  assert.deepEqual(plan.blocks[0]?.power, { format: 'watts', low: 200, high: 200 });
});

await test('invalid or empty files parse to null', () => {
  assert.equal(parsePlan('not xml at all <'), null);
  assert.equal(parsePlan('<workoutFile><Name>Empty</Name></workoutFile>'), null);
  assert.equal(
    parsePlan(
      '<workoutFile><Sections><Section name="Lap"><Block type="lap" time="60"/></Section></Sections></workoutFile>',
    ),
    null,
  );
});

await test('a plan of an untrusted file is bounded in its blocks and in the length of a block', () => {
  const huge = `<workoutFile><Name>x</Name><Sections><Section name="a" repeats="1000000000"><Block type="steady" time="5" targetPowerPct="50"/></Section></Sections></workoutFile>`;
  const long = `<workoutFile><Name>x</Name><Sections><Section name="a"><Block type="steady" time="1e12" targetPowerPct="50"/></Section></Sections></workoutFile>`;

  assert.equal(parsePlan(huge), null);
  assert.equal(parsePlan(long)?.blocks[0]?.durationSeconds, 86_400);
});
