import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { RuntimeContext } from '#src/context';
import { VoiceService, type VoiceEvent } from '#src/services/voice.service';

const quiet = { info() {}, warn() {}, verbose() {}, error() {} };

// SAFETY: VoiceService only reads world.lifecycle.log from the context, which this stub provides.
const context = { world: { lifecycle: { log: quiet } } } as never;

function service(t: TestContext) {
  const scope = Effect.runSync(Scope.make());

  const built = Effect.runSync(
    Layer.buildWithScope(VoiceService.layer.pipe(Layer.provide(Layer.succeed(RuntimeContext, context))), scope),
  );

  t.after(() => Effect.runSync(Scope.close(scope, Exit.void)));

  return Context.get(built, VoiceService);
}

const wait = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

const feed = (voice: ReturnType<typeof service>, line: string) => Effect.runSync(voice.onZwiftLine(line));

await test('chat bubbles reach the clients whose rider is a recipient', (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  const unsubscribe = Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );

  Effect.runSync(voice.onSocial({ playerId: 42n, from: 'Race Leader', text: 'Surge in 30 seconds' }, [7n]));
  Effect.runSync(voice.onSocial({ playerId: 42n, from: 'Race Leader', text: 'Nobody nearby hears' }, [9n]));

  unsubscribe();
  Effect.runSync(voice.onSocial({ playerId: 42n, from: 'Race Leader', text: 'Too late' }, [7n]));

  assert.equal(mine.length, 1);
  assert.match(mine[0]?.speak ?? '', /^Race Leader, mówi: Surge in 30 seconds$/);
});

await test('the rider speaks their own bubble without a name', (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'en', (event) => {
      mine.push(event);
    }),
  );
  Effect.runSync(voice.onSocial({ playerId: 7n, from: 'Tom Smith', text: 'hello' }, [7n]));

  assert.equal(mine[0]?.self, true);
  assert.equal(mine[0]?.speak, 'hello');
});

await test('a fetched plan announces the summary at once and the later blocks with time', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );
  Effect.runSync(
    voice.onWorkout(7, {
      name: 'Quick',
      blocks: [
        {
          name: 'Go',
          durationSeconds: 5,
          meters: null,
          power: { format: 'watts', low: 200, high: 200 },
          cadence: null,
        },
        { name: 'Back', durationSeconds: 3, meters: null, power: null, cadence: null },
      ],
      totalSeconds: 8,
    }),
  );

  assert.equal(mine.length, 0);

  await wait(50);

  assert.equal(mine.at(-1)?.kind, 'summary');

  await wait(8300);

  assert.deepEqual(
    mine.map((event) => event.kind),
    ['summary', 'block', 'finish'],
  );
  assert.match(mine[1]?.speak ?? '', /^Za chwilę blok 2 z 2, Back po 3 sekundy, dowolna moc\.$/);
});

await test('the client log narrates a workout the server never saw', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );
  feed(
    voice,
    '[14:41:11] INFO LEVEL: [GameState] Starting Workout. {workoutID: 898669740, workoutUniqueID: "4073ba6f-2086-4148-b50d-cea9a4e7d23e"}',
  );

  assert.equal(mine.at(-1)?.kind, 'start');

  feed(voice, '[14:41:41] INFO LEVEL: [FTMS] ERG 200w --> 210w');
  assert.equal(mine.at(-1)?.speak, 'Cel mocy: 210 watów.'); // the first target arrives at once

  feed(voice, '[14:41:42] INFO LEVEL: [FTMS] ERG 210w --> 225w');
  assert.equal(mine.length, 2); // later bursts wait for the level to settle

  await wait(2100);

  assert.equal(mine.at(-1)?.kind, 'target');
  assert.equal(mine.at(-1)?.speak, 'Cel mocy: 225 watów.');

  feed(voice, '[14:50:00] [XP] Granting XP: 5, XP Type: XP_WORKOUT'); // per interval: not an ending
  feed(voice, '[14:50:01] INFO LEVEL: [FTMS] ERG 225w --> 265w');
  await wait(2100);
  assert.equal(mine.at(-1)?.speak, 'Cel mocy: 265 watów.');

  feed(voice, '[14:55:00] [GameState] SendApplicationSessionEndEvent');
  feed(voice, '[14:55:01] INFO LEVEL: [FTMS] ERG 0w --> 150w'); // after the ride: not narrated
  await wait(2100);
  assert.equal(mine.at(-1)?.speak, 'Cel mocy: 265 watów.');
});

await test('a plan this server announced is not announced again when the game log takes over', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );
  Effect.runSync(
    voice.onWorkout(7, {
      name: 'Mine',
      blocks: [{ name: 'Go', durationSeconds: 1, meters: null, power: null, cadence: null }],
      totalSeconds: 1,
    }),
  );
  await wait(50);

  feed(voice, '[14:41:11] INFO LEVEL: [GameState] Starting Workout. {workoutID: 1, workoutUniqueID: "u"}');
  feed(voice, '[FTMS] ERG 0w --> 200w');
  feed(voice, '[Splits] Cycling Split 1 started');

  await wait(1300);

  assert.deepEqual(
    mine.map((event) => event.kind),
    ['summary', 'finish'],
  );
  Effect.runSync(voice.stop(7));
});

await test('a new workout replaces the schedule of the previous one', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );
  Effect.runSync(
    voice.onWorkout(7, {
      name: 'Old',
      blocks: [{ name: 'Long', durationSeconds: 30, meters: null, power: null, cadence: null }],
      totalSeconds: 30,
    }),
  );
  Effect.runSync(
    voice.onWorkout(7, {
      name: 'New',
      blocks: [{ name: 'Go', durationSeconds: 1, meters: null, power: null, cadence: null }],
      totalSeconds: 1,
    }),
  );

  await wait(1600);

  assert.deepEqual(
    mine.map((event) => event.kind),
    ['summary', 'finish'],
  );
  Effect.runSync(voice.stop(7));
});

const UUID = 'w1';

const block = (name: string, durationSeconds: number, low: number, high = low) => ({
  name,
  durationSeconds,
  meters: null,
  power: { format: 'ftp' as const, low, high },
  cadence: null,
});

/** A bundled workout: a 180 s ramp warm-up, then 30 s at 100 %, 30 s at 70 %, then 60 s at 90 %. */
const wild = () =>
  new Map([
    [
      UUID,
      {
        id: '1',
        uuid: UUID,
        cues: [
          { at: 100, message: 'Spin those legs.' },
          { at: 200, message: 'Hold on.' },
          { at: 250, message: 'Easy now.' },
        ],
        plan: {
          name: 'Wild',
          blocks: [block('Warmup', 180, 70, 88), block('Hard', 30, 100), block('Easy', 30, 70), block('Tempo', 60, 90)],
          totalSeconds: 300,
        },
      },
    ],
  ]);

const START = `[GameState] Starting Workout. {workoutID: 1, workoutUniqueID: "${UUID}"}`;
const split = (n: number) => `[Splits] Cycling Split ${n} started`;

/** A narrating service whose clock the test drives, and the events its client hears. */
function narrated(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(voice.setWadWorkouts(wild()));
  Effect.runSync(
    voice.subscribe(1, 'en', (event) => {
      mine.push(event);
    }),
  );

  return { voice, mine, kinds: () => mine.map((event) => `${event.kind}:${event.speak.slice(0, 12)}`) };
}

await test('a segment is read when the game starts it, not when a clock says so', (t) => {
  const { voice, mine } = narrated(t);

  feed(voice, START);
  feed(voice, split(1));
  assert.deepEqual(
    mine.map((event) => event.kind),
    ['summary'],
  );

  // Ten minutes of the clock change nothing: the game has not started another segment.
  t.mock.timers.tick(10 * 60_000);
  assert.equal(mine.filter((event) => event.kind === 'block').length, 0);

  feed(voice, split(3));
  assert.match(mine.at(-1)?.speak ?? '', /^Now, block 3 of 4: Easy/);
  assert.equal(mine.at(-1)?.kind, 'block');
  feed(voice, '[GameState] Starting Free Ride.');
});

await test('captions of a segment run from the start of that segment and stop with the next one', (t) => {
  const { voice, mine } = narrated(t);
  const cues = () => mine.filter((event) => event.kind === 'cue').map((event) => event.speak);

  feed(voice, START);
  feed(voice, split(1));
  t.mock.timers.tick(100_000);
  assert.deepEqual(cues(), ['Spin those legs.']); // at 100 s of the warm-up

  // The rider paused: segment 2 starts late. Its caption is 20 s after its own start, and segment 3 comes first.
  feed(voice, split(2));
  t.mock.timers.tick(5000);
  feed(voice, split(3));
  t.mock.timers.tick(60_000);
  assert.deepEqual(cues(), ['Spin those legs.']);

  feed(voice, split(4));
  t.mock.timers.tick(11_000);
  assert.deepEqual(cues(), ['Spin those legs.', 'Easy now.']); // 10 s into the last segment
  feed(voice, '[GameState] Starting Free Ride.');
});

for (const ending of [
  '[GameState] Ending Ride.',
  'sending WORKOUT_ABANDONED analytics event',
  '[GameState] Starting Free Ride.',
])
  await test(`the narration is silenced by: ${ending}`, (t) => {
    const { voice, mine } = narrated(t);

    feed(voice, START);
    feed(voice, split(1));
    feed(voice, ending);
    t.mock.timers.tick(10 * 60_000);

    assert.deepEqual(
      mine.map((event) => event.kind),
      ['summary'],
    );
    feed(voice, split(2));
    assert.equal(mine.length, 1, 'a split after the end brings nothing back');
  });

await test('when the game goes quiet the narration stops, and a later segment brings it back', (t) => {
  const { voice, mine } = narrated(t);

  feed(voice, START);
  feed(voice, split(1));
  t.mock.timers.tick(10 * 60_000); // longer than any pause: the game has gone

  const before = mine.length;

  t.mock.timers.tick(5 * 60_000);
  assert.equal(mine.length, before);

  // The rider is back and the game starts segment 3: the narration follows the workout again, without the summary.
  feed(voice, split(3));
  assert.equal(mine.at(-1)?.kind, 'block');
  assert.ok(mine.slice(before).every((event) => event.kind !== 'summary'));
  feed(voice, '[GameState] Starting Free Ride.');
});

await test('the steps of a ramp put the captions back on the screen after a pause', (t) => {
  const { voice, mine } = narrated(t);

  // The first target before the start teaches the FTP: 210 W at 70 % is 300 W.
  feed(voice, '[FTMS] ERG 0w --> 210w');
  feed(voice, START);
  feed(voice, split(1));

  // 70 s of the clock, but the ramp has only reached 75 % (225 W): the rider paused for 20 s.
  t.mock.timers.tick(70_000);
  feed(voice, '[FTMS] ERG 210w --> 225w');
  t.mock.timers.tick(49_000);
  assert.equal(mine.filter((event) => event.kind === 'cue').length, 0); // the caption at 100 s is 50 s away
  t.mock.timers.tick(2000);
  assert.equal(mine.filter((event) => event.kind === 'cue').length, 1);
  feed(voice, '[GameState] Starting Free Ride.');
});

await test('chat is spoken in the language it was written in', (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'en', (event) => {
      mine.push(event);
    }),
  );
  Effect.runSync(
    voice.onSocial({ playerId: 42n, from: 'Ben Healy', text: 'Teraz albo wcale, panowie. Dociskamy.' }, [7n]),
  );
  Effect.runSync(voice.onSocial({ playerId: 42n, from: 'Ben Healy', text: 'Go now, we drop them.' }, [7n]));

  assert.equal(mine[0]?.lang, 'pl');
  assert.equal(mine[1]?.lang, 'en');
});

// --- New tests: server-fetched, split-driven workouts ---

await test('a plan fetched from the server is read by the segments the game starts, not by the clock', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );

  const plan = {
    name: 'SplitDriven',
    blocks: [
      { name: 'A', durationSeconds: 20, meters: null, power: null, cadence: null },
      { name: 'B', durationSeconds: 20, meters: null, power: null, cadence: null },
      { name: 'C', durationSeconds: 20, meters: null, power: null, cadence: null },
    ],
    totalSeconds: 60,
  };

  Effect.runSync(voice.onWorkout(7, plan));

  await wait(50);

  assert.equal(mine.at(-1)?.kind, 'summary');

  feed(voice, '[GameState] Starting Workout. {workoutID: 7, workoutUniqueID: "abc"}');

  await wait(100);

  const summaryCount = mine.filter((event) => event.kind === 'summary').length;

  assert.equal(summaryCount, 1);

  feed(voice, '[Splits] Cycling Split 2 started');
  assert.equal(mine.at(-1)?.kind, 'block');

  feed(voice, '[Splits] Cycling Split 3 started');
  assert.equal(mine.at(-1)?.kind, 'block');
});

await test('the game log that comes before the fetch of the plan starts the split-driven narration at once', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );

  feed(voice, '[GameState] Starting Workout. {workoutID: 99, workoutUniqueID: "xyz"}');
  assert.equal(mine.at(-1)?.kind, 'start');

  const plan = {
    name: 'Late',
    blocks: [
      { name: 'A', durationSeconds: 20, meters: null, power: null, cadence: null },
      { name: 'B', durationSeconds: 20, meters: null, power: null, cadence: null },
      { name: 'C', durationSeconds: 20, meters: null, power: null, cadence: null },
    ],
    totalSeconds: 60,
  };

  Effect.runSync(voice.onWorkout(7, plan));
  assert.equal(mine.at(-1)?.kind, 'summary');

  feed(voice, '[Splits] Cycling Split 2 started');
  assert.equal(mine.at(-1)?.kind, 'block');

  await wait(100);

  const afterWait = mine.filter((event) => event.kind === 'block').length;

  assert.equal(afterWait, 1);
});

await test('the end of the ride stops the schedule of a fetched plan', async (t) => {
  const voice = service(t);
  const mine: VoiceEvent[] = [];

  Effect.runSync(
    voice.subscribe(7, 'pl', (event) => {
      mine.push(event);
    }),
  );

  const plan = {
    name: 'Short',
    blocks: [{ name: 'Go', durationSeconds: 1, meters: null, power: null, cadence: null }],
    totalSeconds: 1,
  };

  Effect.runSync(voice.onWorkout(7, plan));

  await wait(50);

  assert.equal(mine.at(-1)?.kind, 'summary');

  feed(voice, '[GameState] Ending Ride.');

  await wait(1300);

  const finishCount = mine.filter((event) => event.kind === 'finish').length;

  assert.equal(finishCount, 0);
});
