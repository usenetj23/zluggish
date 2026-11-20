import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { parseLine, tailZwiftLog, tailZwiftLogOverHttp } from '#src/world/zwiftlog';

await test('the workout the game starts is a fact', () => {
  const fact = parseLine(
    '[14:41:11] INFO LEVEL: [GameState] Starting Workout. {workoutID: 898669740, workoutUniqueID: "4073ba6f-2086-4148-b50d-cea9a4e7d23e"}',
  );

  assert.deepEqual(fact, { kind: 'workout-start', id: 898_669_740, uuid: '4073ba6f-2086-4148-b50d-cea9a4e7d23e' });
});

await test('ERG target changes narrate the block the screen shows', () => {
  assert.deepEqual(parseLine('[14:41:41] INFO LEVEL: [FTMS] ERG 235w --> 250w'), { kind: 'erg', from: 235, to: 250 });
});

await test('endings are facts, and the per-interval XP is not', () => {
  assert.equal(parseLine('[XP] Granting XP: 5, XP Type: XP_WORKOUT'), null);
  assert.deepEqual(parseLine('sending WORKOUT_ABANDONED analytics event'), { kind: 'abandoned' });
  assert.deepEqual(parseLine('[GameState] Starting Free Ride.'), { kind: 'free-ride' });
  assert.deepEqual(parseLine('[GameState] SendApplicationSessionEndEvent'), { kind: 'session-end' });
});

await test('the game numbers the segments of a workout and says when the ride ends', () => {
  assert.deepEqual(parseLine('[22:09:15] INFO LEVEL: [Splits] Cycling Split 3 started'), { kind: 'split', n: 3 });
  assert.deepEqual(parseLine('[22:09:15] INFO LEVEL: [Splits] Cycling Split 12 started'), { kind: 'split', n: 12 });
  assert.deepEqual(parseLine('[22:14:30] INFO LEVEL: [GameState] Ending Ride.'), { kind: 'ride-end' });
  assert.equal(parseLine('[22:09:15] INFO LEVEL: [Splits] Cycling Split lap'), null);
});

await test('every other line says nothing', () => {
  assert.equal(parseLine('[14:41:17] INFO LEVEL: [SaveActivityService] autosaving activity'), null);
  assert.equal(parseLine(''), null);
});

await test('the tail feeds new lines until it is stopped, and then it feeds nothing', async () => {
  const folder = mkdtempSync(resolve(tmpdir(), 'zwiftlog-'));
  const path = resolve(folder, 'Log.txt');
  writeFileSync(path, 'old line\n');

  const lines: string[] = [];

  const stop = tailZwiftLog(path, (line) => {
    lines.push(line);
  });

  try {
    appendFileSync(path, 'first\n');
    await sleep(1000);
    assert.deepEqual(lines, ['first']);

    stop();
    appendFileSync(path, 'second\n');
    await sleep(1000);
    assert.deepEqual(lines, ['first']);
  } finally {
    stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

await test('the helper tail starts at the end, joins half lines and reads a recreated log from the top', async (t) => {
  const asked: string[] = [];

  // What the helper says to each poll: the size of the log, then new bytes, a half line, then a new log.
  const answers = new Map<string, { body: string; size: number; start: number }>([
    ['', { body: '', size: 100, start: 100 }],
    ['?offset=100', { body: 'first\nsec', size: 109, start: 100 }],
    ['?offset=109', { body: 'ond\n', size: 113, start: 109 }],
    ['?offset=113', { body: 'fresh\n', size: 6, start: 0 }],
  ]);

  t.mock.method(globalThis, 'fetch', (url: string | URL | Request) => {
    const query = String(url).replace(/^.*\/zwift-log/, '');
    const answer = answers.get(query);

    asked.push(query);

    return Promise.resolve(
      answer
        ? new Response(answer.body, {
            headers: { 'X-Log-Size': String(answer.size), 'X-Log-Start': String(answer.start) },
          })
        : new Response('', { status: 404 }),
    );
  });

  const lines: string[] = [];

  const stop = tailZwiftLogOverHttp(
    'http://mac.test:8099',
    (line) => {
      lines.push(line);
    },
    10,
  );

  try {
    await sleep(300);
  } finally {
    stop();
  }

  assert.deepEqual(lines, ['first', 'second', 'fresh']);
  assert.deepEqual(asked.slice(0, 4), ['', '?offset=100', '?offset=109', '?offset=113']);
});

await test('a helper that does not answer is tried again and feeds nothing', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('no helper')));
  const lines: string[] = [];

  const stop = tailZwiftLogOverHttp(
    'http://mac.test:8099',
    (line) => {
      lines.push(line);
    },
    10,
  );

  try {
    await sleep(100);
  } finally {
    stop();
  }

  assert.ok(network.mock.callCount() >= 2);
  assert.deepEqual(lines, []);
});
