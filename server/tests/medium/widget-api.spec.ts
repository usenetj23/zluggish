import { WebSessionsService } from '#src/services/web-session.service';
import { ProfilesService } from '#src/services/profile.service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { createWebApp } from '#src/http/web-app';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { mediumFixture } from '#tests/medium/support';
import { answerOf } from '#tests/support/rpc';
import { widgetNearbyRecordSchema } from '#src/dtos/widget-api.dto';
import { Schema } from 'effect';
import { worldTime } from '#src/world/state';

/** One v2 argument, base64url encoded the way the widget transport encodes it. */
const arg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
The Sauce routes reveal a neighbourhood, so they may only reveal what the viewer is allowed to see of
every rider in it: another rider's FTP and weight stay private, and a training stress score computed
from a real FTP would hand that FTP back even when the field itself is hidden.
*/

/** Both riders ride the same road in the same direction; `other` sits a little ahead of `rider`. */
function packet(id: bigint, index: number, ahead: boolean, power = 200) {
  const offset = ahead ? 500 : 0;

  return create(PlayerStateSchema, {
    id,
    roadTime: 5000 + index * 1000 + offset,
    worldTime: worldTime() + BigInt(index * 1000),
    power,
    speed: 36_000_000,
    x: ahead ? 5000 + index * 10_000 : index * 10_000,
    f19: (6 << 16) | 4,
    aux3: 100 << 8,
    distance: index * 10,
  });
}

/** One rider's power in every one of its packets: the viewer rides 250 W and the other rider 320 W,
so the two are told apart by a single number in any record of the view, and both ride below their own
250 W FTP of the fixture. */
function powerOf(user: { player_id: number }, otherId: number): number {
  return user.player_id === otherId ? 320 : 250;
}

/**
The same road, the same direction and the same speed, but the gap is two metres: `other` rolls two
metres (x is in centimetres) ahead of `rider`, both pushing 250 W, so the rear rider sits in its
slipstream from the very first second (see `world/draft.ts`).
*/
function slipstreamPacket(id: bigint, index: number, ahead: boolean) {
  return create(PlayerStateSchema, {
    id,
    roadTime: 5000 + index * 1000 + (ahead ? 100 : 0),
    worldTime: worldTime() + BigInt(index * 1000),
    power: 250,
    speed: 36_000_000,
    x: ahead ? 200 + index * 10_000 : index * 10_000,
    f19: (6 << 16) | 4,
    aux3: 100 << 8,
    distance: index * 10,
  });
}

// Sends a request with a same-origin Origin and an optional session cookie by default; `extra`
// overrides headers, and a header whose value is the empty string is removed, i.e. not sent at all.
const headersOf = (session?: string, extra: Readonly<Record<string, string>> = {}) => {
  const entries: Array<[string, string]> = [
    ...(session ? [['Cookie', `zluggish_web_session=${session}`] satisfies [string, string]] : []),
    ['Origin', 'http://local:8080'],
    ...Object.entries(extra),
  ];

  return Object.fromEntries(entries.filter(([, value]) => value !== ''));
};

async function neighbourhood(t: Parameters<typeof mediumFixture>[0]) {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const sessions = f.effects.runSync(WebSessionsService);
  const profiles = f.effects.runSync(ProfilesService);

  for (const [user, privacy] of [
    [f.rider, 0n],
    [f.other, 0n],
  ] as const) {
    const stored = f.effects.runSync(profiles.get(user.player_id));

    stored.ftp = 250;
    stored.weightInGrams = 70_000;
    // Weight of `other` is not shared with anybody: its privacy bits keep the weight bit clear.
    stored.privacyBits = privacy;

    f.effects.runSync(profiles.save(user.player_id, stored));
  }

  for (const user of [f.rider, f.other]) {
    const id = BigInt(user.player_id);

    f.world.login(id, new Uint8Array(16));

    for (const index of [0, 1, 2, 3, 4, 5]) {
      f.world.receive(id, packet(id, index, user === f.other, powerOf(user, f.other.player_id)));
    }
  }

  const sessionOf = (user: typeof f.rider) => f.effects.runSync(sessions.create(f.accounts.identityOf(user)));

  const get = (path: string, session?: string, extra: Record<string, string> = {}) =>
    web.request(`http://local:8080${path}`, { headers: headersOf(session, extra) });

  // The JSON POST of the same site: the CSRF middleware of `web-app.ts` demands, for every non-GET
  // of `/api/*`, this site's Origin and an `X-CSRF-Token` matching the session's own token, so a
  // session id alone cannot build a legal POST. A header of `extra` set to the empty string is
  // dropped, exactly as with `get`.
  const post = (path: string, session: string, body: unknown, extra: Record<string, string> = {}) => {
    const csrf = f.effects.runSync(sessions.find(session))?.csrf ?? '';

    return web.request(`http://local:8080${path}`, {
      method: 'POST',
      headers: headersOf(session, { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extra }),
      body: JSON.stringify(body),
    });
  };

  // A third rider that is signed in but never rides: the viewer of the "not riding" probes.
  const idle = await f.accounts.create('Idle Rider', 'test-password');

  return { f, get, post, sessionOf, idle };
}

await test(
  'Sauce nearby data hides the FTP and weight of other riders and scores their ride at FTP 0',
  { timeout: 30_000 },
  async (t) => {
    const { f, get, sessionOf } = await neighbourhood(t);
    const owner = sessionOf(f.rider);
    const peer = sessionOf(f.other);

    const anonymous = await get('/api/rpc/v2/getNearbyData');

    assert.equal(anonymous.status, 401);

    const nearby = await get('/api/rpc/v2/getNearbyData', owner.id);

    assert.equal(nearby.status, 200);

    const body = await answerOf(nearby, Schema.Array(widgetNearbyRecordSchema));

    assert.equal(body.success, true);
    assert.equal(body.value.length, 2);

    const mine = body.value.find((record) => record.athleteId === f.rider.player_id)!;
    const others = body.value.find((record) => record.athleteId === f.other.player_id)!;

    assert.equal(mine.watching, true);
    assert.equal(mine.athlete.ftp, 250);
    assert.equal(mine.athlete.weight, 70);

    assert.equal(others.watching, false);
    assert.equal(others.athlete.ftp, 0);
    assert.equal(others.athlete.weight, 0);
    // The ride is real: only the score that would betray the FTP is gone.
    assert.equal(others.stats.power.avg, 320);
    assert.equal(others.stats.power.tss, 0);
    assert.equal(mine.stats.power.avg, 250);
    assert.ok(others.athlete.sanitizedFullname.length > 0);

    const symmetric = await answerOf(
      await get('/api/rpc/v2/getNearbyData', peer.id),
      Schema.Array(widgetNearbyRecordSchema),
    );

    assert.equal(symmetric.value.length, 2);
    assert.equal(symmetric.value.find((record) => record.athleteId === f.other.player_id)!.watching, true);
    assert.equal(symmetric.value.find((record) => record.athleteId === f.other.player_id)!.athlete.ftp, 250);
    assert.equal(symmetric.value.find((record) => record.athleteId === f.other.player_id)!.athlete.weight, 70);
    assert.equal(symmetric.value.find((record) => record.athleteId === f.rider.player_id)!.athlete.ftp, 0);
    assert.equal(symmetric.value.find((record) => record.athleteId === f.rider.player_id)!.stats.power.tss, 0);

    const connection = await get('/api/rpc/v2/getGameConnectionStatus', owner.id);

    assert.equal(connection.status, 200);
    assert.deepEqual(await connection.json(), { success: true, value: { connected: true } });
  },
);

/** Every second of riding the world has received is one second of the W' model, so packets fed a
whole second apart drain the balance second by second: riding above the FTP takes exactly the surplus
of every second from the 20 kJ capacity. The fixture rides six seconds at 250 W, at the 250 W FTP of
the fixture, so the balance stays full; the owner then rides a full minute at 310 W, 60 W above
it, while the neighbour never leaves its 320 W. */
async function drainedByRidingAboveFtp(t: Parameters<typeof mediumFixture>[0]) {
  const { f, get, sessionOf } = await neighbourhood(t);
  const owner = sessionOf(f.rider);
  const id = BigInt(f.rider.player_id);

  for (let index = 6; index <= 65; index += 1) {
    f.world.receive(id, packet(id, index, false, 310));
  }

  return { f, get, owner };
}

await test(
  'the W balance of the watched rider is its own, every other rider is answered without one',
  { timeout: 30_000 },
  async (t) => {
    // Six fixture seconds at 250 W leave the 20 kJ balance full (the FTP of the fixture is 250 W),
    // then a minute at 310 W drains 60 J a second: the balance is exactly 20_000 - 60 * 60. The
    // neighbour never leaves its 320 W of the fixture.
    const { get, owner, f } = await drainedByRidingAboveFtp(t);

    const nearby = await answerOf(
      await get('/api/rpc/v2/getNearbyData', owner.id),
      Schema.Array(widgetNearbyRecordSchema),
    );
    const mine = nearby.value.find((record) => record.watching)!;
    const others = nearby.value.find((record) => !record.watching)!;

    assert.equal(mine.athleteId, f.rider.player_id);
    // A full balance (capped at the 20 kJ W' capacity) minus a minute of 60 J a second drained by
    // riding 60 W above the 250 W FTP, and the gauge the pages compute needs the capacity it was
    // drained from.
    assert.equal(mine.wBal, 20_000 - 60 * 60);
    assert.equal(mine.athlete.wPrime, 20_000);

    assert.equal(others.athleteId, f.other.player_id);
    // The FTP of another rider is private, so its balance is not computed and nothing is handed over.
    assert.equal(others.wBal, null);
    assert.equal(others.athlete.wPrime, 0);

    const athlete = await answerOf(
      await get(`/api/rpc/v2/getAthleteData/${arg('self')}`, owner.id),
      widgetNearbyRecordSchema,
    );

    assert.equal(athlete.success, true);
    assert.equal(athlete.value.wBal, 20_000 - 60 * 60);
    assert.equal(athlete.value.athlete.wPrime, 20_000);

    // The Analysis page needs both top-level fields: the course for `zwiftMap.setCourse` and the
    // millisecond start of the ride it compares between polls.
    assert.ok(Number.isFinite(athlete.value.created) && athlete.value.created > 0);
    assert.equal(athlete.value.courseId, athlete.value.state.courseId);
  },
);

/** One lap and one reset of the watched rider, over the RPC of a real runtime. */
await test(
  'the draft estimate of the rider sitting in the slipstream is served, the rider in front has none',
  { timeout: 30_000 },
  async (t) => {
    const { f, get, sessionOf } = await neighbourhood(t);
    const owner = sessionOf(f.rider);
    const other = sessionOf(f.other);

    // A re-ridden neighbourhood two metres apart at 250 W: fresh world times, so the fixture's own
    // packets age out; the rear rider is received last at every index, so the rider in front is
    // already known when its gap is measured.
    for (let index = 0; index < 12; index += 1) {
      f.world.receive(BigInt(f.other.player_id), slipstreamPacket(BigInt(f.other.player_id), index, true));
      f.world.receive(BigInt(f.rider.player_id), slipstreamPacket(BigInt(f.rider.player_id), index, false));
    }

    const athleteOf = async (session: string) => {
      const response = await answerOf(
        await get(`/api/rpc/v2/getAthleteData/${arg('self')}`, session),
        widgetNearbyRecordSchema,
      );

      assert.equal(response.success, true);

      return response.value;
    };

    const mine = await athleteOf(owner.id);

    // Two metres at 36 km/h is a 0.2 second gap: a large share of the 250 W is saved from the first
    // second. (No 5 s window is asserted: the world fills only gaps of six seconds or less, and the
    // fixture has aged the fixture packets years ahead, so only the six fed seconds are counted.)
    assert.ok(mine.state.draft > 0);
    assert.ok(mine.stats.draft.avg > 0);
    assert.ok(mine.stats.draft.max > 0);
    assert.ok(mine.stats.draft.kj > 0);

    // The front rider's own record: nobody rides in front of it, so its estimate stays 0.
    const front = await athleteOf(other.id);

    assert.equal(front.state.draft, 0);
    assert.equal(front.stats.draft.avg, 0);
  },
);

await test(
  'the athlete record of a bot rider carries the facts of storage/bot-profiles.json and a real rider carries none',
  { timeout: 30_000 },
  async (t) => {
    const { f, get, sessionOf } = await neighbourhood(t);
    const owner = sessionOf(f.rider);
    // isBotId: bot ids run from 8 000 001 up to below 9 000 000.
    const botId = 8_500_000n;
    const profiles = f.effects.runSync(ProfilesService);

    f.world.synthetic.set(botId, packet(botId, 5, true));

    // A bot rider is not a user: its profile lives in the world only, as the bot loader leaves it.
    profiles.synthetic.set(botId, create(PlayerProfileSchema, { id: botId, firstName: 'Test', lastName: 'Bot (UAD)' }));

    writeFileSync(
      resolve(f.config.storageDir, 'bot-profiles.json'),
      JSON.stringify({
        version: 1,
        teams: { UAD: { name: 'UAE Team Emirates', country: 'AE', website: 'https://uae.example' } },
        riders: [
          {
            name: 'Test Bot (UAD)',
            country: 'SI',
            team: 'UAD',
            pcs: 'test-bot',
            born: '1998-09-21',
            birthplace: 'Klanec',
            bio: 'Test bio.',
            photo: {
              url: 'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg',
              author: 'Test Author',
              license: 'CC BY 4.0',
              source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
            },
            wikidata: 'Q1',
          },
        ],
      }),
    );

    const bot = await athleteOf(get, owner.id, Number(botId));

    assert.notEqual(bot, null);
    assert.equal(bot!.athlete.bot?.teamName, 'UAE Team Emirates');
    assert.equal(bot!.athlete.bot?.countryName, 'Slovenia');
    assert.equal(bot!.athlete.bot?.born, '1998-09-21');
    assert.equal(bot!.athlete.bot?.birthplace, 'Klanec');
    assert.equal(bot!.athlete.bot?.photo?.author, 'Test Author');

    const other = await athleteOf(get, owner.id, f.other.player_id);

    assert.equal(other?.athlete.bot, null);
  },
);

type Get = Awaited<ReturnType<typeof neighbourhood>>['get'];

/** The record of one athlete id out of a `getAthleteData` answer. */
async function athleteOf(get: Get, session: string, ident: unknown) {
  const response = await get(`/api/rpc/v2/getAthleteData/${arg(ident)}`, session);

  assert.equal(response.status, 200);

  const answer = await answerOf(response, Schema.NullOr(widgetNearbyRecordSchema));

  return answer.value;
}

await test(
  'getPlayerState answers the live state of a rider in the viewer world and null for an id nobody rides',
  { timeout: 30_000 },
  async (t) => {
    const { f, get, sessionOf } = await neighbourhood(t);
    const owner = sessionOf(f.rider);

    // The viewer's own rider, riding the fixture packets at 250 W.
    const mine = await get(`/api/rpc/v2/getPlayerState/${arg(f.rider.player_id)}`, owner.id);

    assert.equal(mine.status, 200);

    const body = await answerOf(mine, Schema.NullOr(Schema.Struct({ power: Schema.Finite, sport: Schema.String })));

    assert.equal(body.success, true);
    assert.notEqual(body.value, null);
    assert.equal(body.value?.power, 250);

    // An id nobody rides here: the same visibility rule as `getAthleteData` — no record, no state.
    const unknown = await get(`/api/rpc/v2/getPlayerState/${arg(999_999)}`, owner.id);

    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { success: true, value: null });
  },
);
