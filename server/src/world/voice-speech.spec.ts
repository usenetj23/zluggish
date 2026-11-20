import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockSpeech,
  chatSpeech,
  countdownSpeech,
  fmtDuration,
  fmtPower,
  summarySpeech,
} from '#src/world/voice-speech';
import type { PlanBlock } from '#src/world/zwo';

const block = (over: Partial<PlanBlock> = {}): PlanBlock => ({
  name: '',
  durationSeconds: 600,
  meters: null,
  power: { format: 'watts', low: 200, high: 200 },
  cadence: null,
  ...over,
});

await test('polish counts agree with the words', () => {
  assert.equal(fmtDuration(1, 'pl'), '1 sekunda');
  assert.equal(fmtDuration(5, 'pl'), '5 sekund');
  assert.equal(fmtDuration(60, 'pl'), '1 minuta');
  assert.equal(fmtDuration(90, 'pl'), '1 minuta i 30 sekund');
  assert.equal(fmtDuration(120, 'pl'), '2 minuty');
  assert.equal(fmtDuration(600, 'pl'), '10 minut');
  assert.equal(fmtDuration(90, 'en'), '1 minutes and 30 seconds');
});

await test('power levels, ranges and percents read like a coach', () => {
  assert.equal(fmtPower(block().power, 'pl'), 'po 200 watów');
  assert.equal(fmtPower({ format: 'watts', low: 268, high: 280 }, 'pl'), 'po 268 do 280 watów');
  assert.equal(fmtPower({ format: 'ftp', low: 88, high: 92 }, 'pl'), 'po 88 do 92 procent FTP');
  assert.equal(fmtPower(null, 'pl'), 'dowolna moc');
  assert.equal(fmtPower({ format: 'watts', low: 268, high: 280 }, 'en'), 'at 268 to 280 watts');
});

await test('a block names its place, time, power and cadence', () => {
  assert.equal(
    blockSpeech(block({ name: 'Main Set', power: { format: 'watts', low: 268, high: 280 }, cadence: 92 }), 1, 6, 'pl'),
    'Za chwilę blok 2 z 6, Main Set po 10 minut, po 268 do 280 watów, kadencja 92.',
  );
  assert.equal(
    blockSpeech(block({ durationSeconds: null, meters: 400, power: null }), 0, 2, 'pl'),
    'Za chwilę blok 1 z 2 po 400 metrów, dowolna moc.',
  );
  assert.equal(
    blockSpeech(block({ name: 'Main Set' }), 1, 6, 'en'),
    'Up next, block 2 of 6: Main Set, 10 minutes, at 200 watts.',
  );
});

await test('the summary counts blocks with the right polish word', () => {
  const plan = { name: 'Sweet', blocks: [block(), block()], totalSeconds: 120 };

  assert.equal(summarySpeech(plan, 'pl'), 'Trening Sweet: 2 bloki, razem 2 minuty. Jedziemy.');
  assert.equal(
    summarySpeech({ ...plan, blocks: [block()], totalSeconds: 600 }, 'pl'),
    'Trening Sweet: 1 blok, razem 10 minut. Jedziemy.',
  );
});

await test('the countdown promises the next block', () => {
  assert.equal(
    countdownSpeech(15, block({ durationSeconds: 300, power: { format: 'watts', low: 150, high: 160 } }), 'pl'),
    '15 sekund do końca bloku. Następnie 5 minut, po 150 do 160 watów.',
  );
  assert.equal(countdownSpeech(15, null, 'en'), '15 seconds left in this block.');
});

await test('team tags in parentheses are not spoken', () => {
  assert.equal(chatSpeech('M. Hirschi (TUD)', 'go', 'pl'), 'M. Hirschi, mówi: go');
  assert.equal(chatSpeech('An Puch (CDT) (TUD)', 'hi', 'en'), 'An Puch says: hi');
});

await test('a chat bubble leads with the name, except your own', () => {
  assert.equal(chatSpeech('Race Leader', 'Surge in 30 seconds', 'pl'), 'Race Leader, mówi: Surge in 30 seconds');
  assert.equal(chatSpeech('', 'hello', 'en'), 'hello');
});
