import { World } from '#src/world/state';
import { WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { create } from '@bufbuild/protobuf';
import { RideOnCounter } from '#src/world/ride-on-count';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Not a number; parsed, since the two linters disagree on how to name the constant. */
const notANumber = Number('NaN');

await test('a rider starts at 0 and every add counts', () => {
  const counter = new RideOnCounter();

  assert.equal(counter.count(7), 0);

  counter.add(7);
  counter.add(7, 3);

  assert.equal(counter.count(7), 4);
});

await test('counts are kept per rider', () => {
  const counter = new RideOnCounter();

  counter.add(7, 2);
  counter.add(8);

  assert.equal(counter.count(7), 2);
  assert.equal(counter.count(8), 1);
});

await test('reset forgets one rider only', () => {
  const counter = new RideOnCounter();

  counter.add(7, 5);
  counter.add(8, 6);
  counter.reset(7);

  assert.equal(counter.count(7), 0);
  assert.equal(counter.count(8), 6);

  counter.add(7);

  assert.equal(counter.count(7), 1);
});

await test('a non-positive or nonsense amount is not counted', () => {
  const counter = new RideOnCounter();

  counter.add(7, 0);
  counter.add(7, -3);
  counter.add(7, notANumber);

  assert.equal(counter.count(7), 0);
});

await test('the counter is bounded: the oldest rider is dropped past 5000 ids', () => {
  const counter = new RideOnCounter();

  for (let id = 0; id < 5000; id += 1) {
    counter.add(id);
  }

  assert.equal(counter.count(0), 1);

  counter.add(5000);

  assert.equal(counter.count(5000), 1);
  assert.equal(counter.count(0), 0);
  assert.equal(counter.count(1), 1);
});

await test('world.enqueue counts a ride on for every recipient and nothing else', () => {
  const world = new World();
  // `enqueue` counts by the attribute type alone; the payload is not read.
  const update = create(WorldAttributeSchema, { waType: WA_TYPE.WAT_RIDE_ON, payload: new Uint8Array() });

  world.enqueue(update, [2n, 3n]);

  assert.equal(world.rideOns.count(2), 1);
  assert.equal(world.rideOns.count(3), 1);
  assert.equal(world.rideOns.count(1), 0);

  world.enqueue(update, [2n]);

  assert.equal(world.rideOns.count(2), 2);
  assert.equal(world.rideOns.count(3), 1);

  // A chat bubble is not a ride on: nothing is counted for it.
  world.enqueue(create(WorldAttributeSchema, { waType: WA_TYPE.WAT_SPA, payload: new Uint8Array([1, 2, 3]) }), [
    2n,
    3n,
  ]);

  assert.equal(world.rideOns.count(2), 2);
  assert.equal(world.rideOns.count(3), 1);
});
