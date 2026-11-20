import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { RuntimeContext } from '#src/context';
import { VoiceService } from '#src/services/voice.service';
import type { VoiceEvent } from '#src/services/voice.service';

const quiet = { info() {}, warn() {}, verbose() {}, error() {} };

// SAFETY: VoiceService only reads world.lifecycle.log from the context, which this stub provides.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
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

await test('chat bubbles reach the clients whose rider is a recipient', (t) => {
  const voice = service(t);
  const mine: Array<VoiceEvent> = [];

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
  const mine: Array<VoiceEvent> = [];

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
  const mine: Array<VoiceEvent> = [];

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

await test('a new workout replaces the schedule of the previous one', async (t) => {
  const voice = service(t);
  const mine: Array<VoiceEvent> = [];

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

await test('chat is spoken in the language it was written in', (t) => {
  const voice = service(t);
  const mine: Array<VoiceEvent> = [];

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
