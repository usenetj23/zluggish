import {
  AthleteDataError,
  AthleteDataStore,
  maxAthleteDataBytes,
  maxAthletesPerViewer,
  maxViewers,
} from '#src/world/athlete-data-store';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('an update is shallow-merged over the stored object and a null key deletes it', { timeout: 10_000 }, () => {
  const store = new AthleteDataStore();

  assert.deepEqual(store.update(1, 7, { lapSets: [{ time: 300 }], note: 'first' }), {
    lapSets: [{ time: 300 }],
    note: 'first',
  });

  // A second call adds a key and replaces one, and drops `note` by naming it null.
  assert.deepEqual(store.update(1, 7, { note: null, cadence: 90 }), { lapSets: [{ time: 300 }], cadence: 90 });

  // A null key nobody stored deletes nothing.
  assert.deepEqual(store.update(1, 7, { absent: null }), { lapSets: [{ time: 300 }], cadence: 90 });
});

await test('a stored object is never mutated in place', { timeout: 10_000 }, () => {
  const store = new AthleteDataStore();

  const first = store.update(1, 7, { a: 1 });
  const second = store.update(1, 7, { b: 2 });

  assert.deepEqual(first, { a: 1 }, 'the answer already handed over stays as it was');
  assert.deepEqual(second, { a: 1, b: 2 });

  second['a'] = 99;

  assert.notDeepEqual(store.update(1, 7, {}), { a: 99, b: 2 }, 'every answer is a copy of the stored object');
});

await test(
  'a forbidden key, a value that is no object and a value past the size limit are refused',
  { timeout: 10_000 },
  () => {
    const store = new AthleteDataStore();

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(
        () => store.update(1, 7, { [key]: 'x' }),
        (error: unknown) => error instanceof AthleteDataError && error.reason === 'forbidden-key',
        key,
      );
    }

    for (const data of [[1, 2], 'text', 7, null, undefined]) {
      assert.throws(
        () => store.update(1, 7, data),
        (error: unknown) => error instanceof AthleteDataError && error.reason === 'not-an-object',
        JSON.stringify(data),
      );
    }

    assert.throws(
      () => store.update(1, 7, { big: 'x'.repeat(maxAthleteDataBytes + 1) }),
      (error: unknown) => error instanceof AthleteDataError && error.reason === 'too-large',
    );

    // Nothing of the refused writes was stored.
    assert.deepEqual(store.update(1, 7, { kept: true }), { kept: true });
  },
);

await test('an update that would grow the merged object past the limit stores nothing', { timeout: 10_000 }, () => {
  const store = new AthleteDataStore();
  const pad = 'x'.repeat(maxAthleteDataBytes - 64);

  store.update(1, 7, { pad });

  assert.throws(
    () => store.update(1, 7, { more: 'y'.repeat(200) }),
    (error: unknown) => error instanceof AthleteDataError && error.reason === 'too-large',
  );

  store.update(1, 7, { gone: 1 });

  assert.deepEqual(Object.keys(store.update(1, 7, { gone: null })), ['pad']);
});

await test('every viewer sees only its own data', { timeout: 10_000 }, () => {
  const store = new AthleteDataStore();

  store.update(1, 7, { from: 'one' });
  store.update(2, 7, { from: 'two' });
  store.update(2, 8, { other: true });

  assert.deepEqual(store.update(2, 7, {}), { from: 'two' });
  assert.deepEqual(store.update(1, 7, {}), { from: 'one' });
  assert.deepEqual(store.update(1, 8, { probe: 1 }), { probe: 1 }, 'athlete 8 of viewer 1 holds nothing');
});

await test('the 41st athlete of a viewer drops the one written longest ago', { timeout: 10_000 }, () => {
  const store = new AthleteDataStore();

  for (let athlete = 1; athlete <= maxAthletesPerViewer; athlete += 1) {
    store.update(1, athlete, { athlete });
  }

  store.update(1, maxAthletesPerViewer + 1, { athlete: maxAthletesPerViewer + 1 });

  // The athlete written longest ago is gone: a merge over it finds nothing.
  assert.deepEqual(store.update(1, 1, { probe: 1 }), { probe: 1 }, 'the oldest athlete is gone');
  assert.deepEqual(store.update(1, maxAthletesPerViewer, {}), { athlete: maxAthletesPerViewer });
  assert.deepEqual(store.update(1, maxAthletesPerViewer + 1, {}), { athlete: maxAthletesPerViewer + 1 });

  // Re-writing an athlete moves it to the newest seat, so the next eviction takes another one.
  const refreshed = new AthleteDataStore();

  for (let athlete = 1; athlete <= maxAthletesPerViewer; athlete += 1) {
    refreshed.update(1, athlete, { athlete });
  }

  refreshed.update(1, 1, { again: true });
  refreshed.update(1, maxAthletesPerViewer + 1, { athlete: maxAthletesPerViewer + 1 });

  assert.deepEqual(refreshed.update(1, 2, { probe: 1 }), { probe: 1 }, 'the next-oldest athlete is gone');
  assert.deepEqual(refreshed.update(1, 1, {}), { athlete: 1, again: true }, 'the refreshed athlete kept its seat');
});

await test('the 501st viewer drops the viewer written longest ago', { timeout: 20_000 }, () => {
  const store = new AthleteDataStore();

  for (let viewer = 1; viewer <= maxViewers; viewer += 1) {
    store.update(viewer, 7, { viewer });
  }

  assert.equal(store.size, maxViewers);

  store.update(1, 8, { refreshed: true });
  store.update(maxViewers + 1, 7, { viewer: maxViewers + 1 });

  assert.equal(store.size, maxViewers, 'one viewer seat is handed back, whole');
  assert.deepEqual(store.update(2, 7, { probe: 1 }), { probe: 1 }, 'the viewer written longest ago is gone');
  assert.deepEqual(store.update(1, 8, {}), { refreshed: true }, 'a touched viewer kept its seat');
  assert.deepEqual(store.update(maxViewers, 7, {}), { viewer: maxViewers });
  assert.deepEqual(store.update(maxViewers + 1, 7, {}), { viewer: maxViewers + 1 });
});
