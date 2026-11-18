import {
  Commentator,
  effortZone,
  fill,
  formatKm,
  loadTemplates,
  type Sample,
  type Templates,
} from '#src/world/commentary';
import { Random } from '#src/world/geometry';
import { formatTime, loadSegments, segmentKind } from '#src/world/segments';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../../assets', import.meta.url));

const sample = (over: Partial<Sample> = {}): Sample => ({
  timeS: 0,
  distanceM: 0,
  power: 0,
  heartrate: 0,
  gradePct: 0,
  climbedM: 0,
  ftp: 0,
  ...over,
});

const texts = (language: string, kinds: Record<string, string[]>, extra = ''): Templates =>
  new Map([
    [
      language,
      {
        texts: new Map(Object.entries(kinds)),
        segmentKinds: { sprint: 'sprint', kom: 'climb', segment: 'segment' },
        heartrate: extra,
      },
    ],
  ]);

const english = texts(
  'en',
  {
    route: ['route {route} {km}'],
    time: ['time {min} avg {avg}{hr_text}'],
    distance: ['distance {km}'],
    climb: ['climb {grade}'],
    descent: ['descent {grade}'],
    stronger: ['stronger {power} vs {avg}'],
    weaker: ['weaker {power} vs {avg}'],
    effort_easy: ['easy {pct} of {ftp}'],
    effort_steady: ['steady {pct}'],
    effort_hard: ['hard {pct}'],
    effort_over: ['over {pct}'],
    burst_end: ['burst {secs} s {pct}'],
    segment_first: ['first {name} {label} {time} {power}'],
    segment_pb: ['pb {name} by {diff} best {best}'],
    segment_same: ['same {name}'],
    segment_slower: ['slower {name} by {diff}'],
    gesture_elbow: ['elbow one', 'elbow two', 'elbow three'],
  },
  ' hr {hr}',
);

const make = (templates: Templates = english, gap = 120) => new Commentator(new Random(7), templates, gap);

/** One packet per second from `from` for `seconds`, the clock of the server equal to the time of the ride. */
const ride = (
  commentator: Commentator,
  from: number,
  seconds: number,
  over: (second: number) => Partial<Sample> = () => ({}),
) => {
  for (let second = from; second < from + seconds; second++)
    commentator.update(second, sample({ timeS: second, ...over(second) }));
};

const language = () => 'en';

/** The last minute at `watts` after a steady ride at 150 W: what is said about it. */
const lastMinute = (watts: number) => {
  const commentator = make();
  ride(commentator, 0, 100, () => ({ power: 150 }));
  commentator.poll(100, language, () => 'Volcano');
  ride(commentator, 100, 260, () => ({ power: 150 }));
  ride(commentator, 360, 60, () => ({ power: watts }));

  return commentator.poll(420, language);
};

/** Riding at `watts` for `seconds` with an FTP of 200 W, after the route has been told: what is said. */
const effort = (watts: number, seconds: number) => {
  const commentator = make(english, 0);
  ride(commentator, 0, 100, () => ({ power: 0, ftp: 200 }));
  commentator.poll(100, language, () => 'Volcano');
  ride(commentator, 100, seconds, () => ({ power: watts, ftp: 200 }));

  return commentator.poll(100 + seconds, language);
};

/** A burst of `burstSeconds` at 260 W, then `wait` seconds more before the rider is asked: what is said. */
const burst = (burstSeconds: number, ftp: number, wait = 0) => {
  const commentator = make();
  ride(commentator, 0, 100, () => ({ power: 100, ftp }));
  commentator.poll(100, language, () => 'Volcano');
  ride(commentator, 100, burstSeconds, () => ({ power: 260, ftp }));
  ride(commentator, 100 + burstSeconds, 5, () => ({ power: 100, ftp }));

  return commentator.poll(100 + burstSeconds + 5 + wait, language);
};

/** A 18.467 s sprint at 500 W, with `previousMs` as the earlier times: what is said. */
const sprint = (previousMs: number[]) => {
  const commentator = make();
  commentator.queueSegment(0, { name: 'Sprint', kind: 'sprint', elapsedMs: 18_467, avgPower: 500, previousMs });

  return commentator.poll(1, language);
};

await test('kilometres drop a zero decimal and effort zones have their boundaries', () => {
  assert.deepEqual(
    [3400, 10_000, 10_020, 3449, 3460].map((meters) => formatKm(meters)),
    ['3.4', '10', '10', '3.4', '3.5'],
  );
  assert.deepEqual(
    [0.59, 0.6, 0.89, 0.9, 1.04, 1.05].map((ratio) => effortZone(ratio)),
    ['easy', 'steady', 'steady', 'hard', 'hard', 'over'],
  );
});

await test('average power only counts the time of pedalling, and a new ride starts the statistics again', () => {
  const commentator = make();
  ride(commentator, 0, 11, () => ({ power: 200 }));
  ride(commentator, 11, 120, () => ({ power: 0 }));

  assert.equal(commentator.averagePower, 200);
  ride(commentator, 0, 1, () => ({ power: 100 }));
  assert.equal(commentator.averagePower, 0, 'the ride clock jumped back: a new ride');
});

await test('nothing is said in the first minute, and the route is told once, after a while', () => {
  const commentator = make();
  ride(commentator, 0, 59);

  assert.equal(
    commentator.poll(59, language, () => 'Volcano'),
    null,
  );
  ride(commentator, 59, 40);
  assert.equal(
    commentator.poll(99, language, () => 'Volcano'),
    'route Volcano 0',
  );
  ride(commentator, 99, 400);
  assert.equal(
    commentator.poll(499, language, () => 'Volcano'),
    null,
  );
});

await test('an unknown route name is retried after a pause, not at every tick', () => {
  const commentator = make();
  ride(commentator, 0, 100);
  let asked = 0;

  const route = () => {
    asked++;

    return null;
  };

  assert.equal(commentator.poll(100, language, route), null);
  assert.equal(commentator.poll(101, language, route), null);
  assert.equal(asked, 1);
  ride(commentator, 100, 40);
  assert.equal(commentator.poll(140, language, route), null);
  assert.equal(asked, 2);
});

await test('every fifteen minutes and ten kilometres are announced, with the heart rate only when there is one', () => {
  const commentator = make();
  ride(commentator, 0, 100, () => ({ power: 150 }));
  commentator.poll(100, language, () => 'Volcano');
  ride(commentator, 100, 802, () => ({ power: 150, heartrate: 0 }));
  assert.equal(commentator.poll(902, language), 'time 15 avg 150');

  ride(commentator, 902, 400, () => ({ power: 150, heartrate: 140, distanceM: 10_020 }));
  assert.equal(commentator.poll(1302, language), 'distance 10');

  const withHeart = make();
  ride(withHeart, 0, 100, () => ({ power: 150 }));
  withHeart.poll(100, language, () => 'Volcano');
  ride(withHeart, 100, 802, () => ({ power: 150, heartrate: 141 }));
  assert.equal(withHeart.poll(902, language), 'time 15 avg 150 hr 141');
});

await test('a climb needs its grade held, a descent the same, and neither comes again within ten minutes', () => {
  const commentator = make(english, 0);
  ride(commentator, 0, 100);
  commentator.poll(100, language, () => 'Volcano');
  ride(commentator, 100, 10, () => ({ gradePct: 5 }));
  assert.equal(commentator.poll(110, language), null, 'the grade was not held long enough');
  ride(commentator, 110, 20, () => ({ gradePct: 5 }));
  assert.equal(commentator.poll(130, language), 'climb 5.0');

  ride(commentator, 130, 40, () => ({ gradePct: 0 }));
  ride(commentator, 170, 30, () => ({ gradePct: 6 }));
  assert.equal(commentator.poll(200, language), null, 'the second climb has to wait for the cooldown');

  ride(commentator, 200, 30, () => ({ gradePct: -6 }));
  assert.equal(commentator.poll(230, language), 'descent -6.0');
});

await test('a stronger or weaker last minute is compared with your average, a steady one says nothing', () => {
  assert.match(lastMinute(240) ?? '', /^stronger 2[34]\d vs 1[56]\d$/);
  assert.match(lastMinute(60) ?? '', /^weaker /);
  assert.equal(lastMinute(150), null);
});

await test('the minimum gap between remarks holds, and the language is asked only when there is something to say', () => {
  const commentator = make();
  ride(commentator, 0, 50);
  let asked = 0;

  const ask = () => {
    asked++;

    return 'en';
  };

  assert.equal(
    commentator.poll(50, ask, () => 'Volcano'),
    null,
  );
  assert.equal(asked, 0);
  ride(commentator, 50, 50);
  assert.equal(
    commentator.poll(100, ask, () => 'Volcano'),
    'route Volcano 0',
  );
  ride(commentator, 100, 40, () => ({ gradePct: 6 }));
  assert.equal(commentator.poll(140, ask), null, 'only 40 s after the last remark');
  ride(commentator, 140, 80, () => ({ gradePct: 6 }));
  assert.equal(commentator.poll(220, ask), 'climb 6.0');
});

await test('Polish uses a decimal comma, and a language without texts falls back to English', () => {
  const polish = texts('pl', { climb: ['wzniesienie {grade}'], route: ['trasa {route}'] });
  const commentator = make(new Map([...english, ...polish]), 0);
  ride(commentator, 0, 100);
  commentator.poll(
    100,
    () => 'pl',
    () => 'Wulkan',
  );
  ride(commentator, 100, 40, () => ({ gradePct: 4.5 }));
  assert.equal(
    commentator.poll(140, () => 'pl'),
    'wzniesienie 4,5',
  );

  const german = make();
  ride(german, 0, 100);
  assert.equal(
    german.poll(
      100,
      () => 'de',
      () => 'Volcano',
    ),
    'route Volcano 0',
  );
  assert.equal(make(new Map()).poll(100, language), null, 'no texts means silence');
});

await test('a restarted server does not repeat what is behind you, and a new ride tells the route again', () => {
  const commentator = make();
  ride(commentator, 1000, 120, () => ({ distanceM: 12_000 }));
  assert.equal(
    commentator.poll(1120, language, () => 'Volcano'),
    null,
  );

  ride(commentator, 0, 100);
  assert.equal(
    commentator.poll(100, language, () => 'Volcano'),
    'route Volcano 0',
  );
});

await test('effort follows the share of FTP, easy needs a minute, hard half of that, and coasting says nothing', () => {
  assert.equal(effort(100, 100), 'easy 50 of 200');
  assert.equal(effort(100, 50), null, 'easy needs a minute at that level');
  assert.equal(effort(190, 70), 'hard 95');
  assert.equal(effort(230, 70), 'over 115');
  assert.equal(effort(0, 100), null);
});

await test('a burst over FTP is asked about when it ends, but not a short one, one without FTP, or an old one', () => {
  assert.match(burst(40, 200) ?? '', /^burst [34]\d s 1[23]\d$/);
  assert.equal(burst(10, 200), null, 'under 20 seconds is no burst');
  assert.equal(burst(40, 0), null, 'without an FTP there is no burst');
  assert.equal(burst(40, 200, 40), null, 'the moment has passed');
});

await test('a rider who gives a hand signal may say a line, within the chance and the spacing', () => {
  const commentator = make();

  assert.equal(commentator.gestureQuip(0, 'elbow', language, 0), null, 'chance 0 means silence');
  assert.match(commentator.gestureQuip(1, 'elbow', language, 1) ?? '', /^elbow /);
  assert.equal(commentator.gestureQuip(10, 'elbow', language, 1), null, 'not more often than the spacing');
  assert.notEqual(commentator.gestureQuip(10, 'elbow', language, 0, true), null, 'force ignores both');
  assert.equal(commentator.gestureQuip(100, 'wave', language, 1), null, 'no texts for that gesture');
  assert.match(commentator.gestureQuip(200, 'elbow', () => 'de', 1) ?? '', /^elbow /);
});

await test('every text is used once before any comes again, and a round never starts with the last text', () => {
  const commentator = make();
  const told = Array.from({ length: 12 }, () => commentator.gestureQuip(0, 'elbow', language, 1, true));

  for (let round = 0; round < 4; round++) assert.equal(new Set(told.slice(round * 3, round * 3 + 3)).size, 3);

  for (let index = 3; index < told.length; index += 3) assert.notEqual(told[index], told[index - 1]);
});

await test('a finished segment is told at once: first time, personal best, the same time or slower', () => {
  assert.equal(sprint([]), 'first Sprint sprint 18.5 s 500');
  assert.equal(sprint([20_000, 19_000]), 'pb Sprint by 0.5 s best 19.0 s');
  assert.equal(sprint([18_480]), 'same Sprint');
  assert.equal(sprint([18_000]), 'slower Sprint by 0.5 s');
});

await test('segments are spaced, and one not told within ninety seconds is dropped', () => {
  const commentator = make();
  commentator.queueSegment(0, { name: 'A', kind: 'kom', elapsedMs: 600_000, avgPower: 300, previousMs: [] });
  commentator.queueSegment(1, { name: 'B', kind: 'sprint', elapsedMs: 20_000, avgPower: 700, previousMs: [] });

  assert.equal(commentator.poll(2, language), 'first A climb 10:00 300');
  assert.equal(commentator.poll(10, language), null, 'the next one waits for the spacing');
  assert.equal(commentator.poll(25, language), 'first B sprint 20.0 s 700');

  commentator.queueSegment(30, { name: 'C', kind: 'segment', elapsedMs: 60_000, avgPower: 300, previousMs: [] });
  assert.equal(commentator.poll(200, language), null, 'the moment has passed');
});

await test('a broken template gives no text and never raises', () => {
  const commentator = make(texts('en', { route: ['route {nothing}'], segment_first: ['{nothing}'] }));
  ride(commentator, 0, 100);

  assert.equal(
    commentator.poll(100, language, () => 'Volcano'),
    null,
  );
  commentator.queueSegment(100, { name: 'A', kind: 'kom', elapsedMs: 1000, avgPower: 1, previousMs: [] });
  assert.equal(commentator.poll(101, language), null);
});

await test('the bundled texts cover the same kinds in English and Polish, fill every placeholder, no duplicates', () => {
  const templates = loadTemplates(assets);
  const en = templates.get('en');
  const pl = templates.get('pl');
  assert.ok(en && pl);
  assert.deepEqual(pl.texts.keys().toArray().toSorted(), en.texts.keys().toArray().toSorted());

  const values = {
    min: 15,
    km: '10',
    avg: 200,
    power: 210,
    hr: 150,
    grade: '5.0',
    climbed: 100,
    route: 'Volcano',
    ftp: 250,
    pct: 84,
    secs: 40,
    name: 'Sprint',
    label: 'sprint',
    time: '18.5 s',
    diff: '0.5 s',
    best: '18.0 s',
    hr_text: ' hr',
  };

  for (const [name, pool] of templates)
    for (const [kind, options] of pool.texts) {
      assert.ok(options.length >= 8, `${name}/${kind} has variety`);
      assert.equal(new Set(options).size, options.length, `${name}/${kind} has no duplicates`);

      for (const text of options) {
        const line = fill(text, values);
        assert.ok(line.length > 0 && line.length <= 260, `${name}/${kind} fits a chat message: ${line.length}`);
      }
    }

  assert.ok(en.heartrate.includes('{hr}'));
});

await test('segment names and kinds come from the game info, with ids that do not lose digits', () => {
  const segments = loadSegments(assets);

  assert.ok(segments.size > 100);
  assert.equal(segments.get('-9223372036854775808')?.name, 'UCI Worlds Reverse');
  assert.equal(segmentKind('UI/Jersey/GreenJersey_Icon.tga'), 'sprint');
  assert.equal(segmentKind('UI/Jersey/PolkaDot_Icon.tga'), 'kom');
  assert.equal(segmentKind(undefined), 'segment');
  assert.deepEqual(
    [18_467, 531_878, 3_605_000, 59_960].map((ms) => formatTime(ms)),
    ['18.5 s', '8:52', '1:00:05', '1:00'],
  );
  assert.equal(formatTime(18_467, true), '18,5 s');
});
