import { WebSessionsService } from '#src/services/web-session.service';
import { ProfilesService } from '#src/services/profile.service';
import { mediumFixture } from '#tests/medium/support';
import { createWebApp } from '#src/http/web-app';
import { PlayerStateSchema, WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { OverlayOptIn } from '#src/world/overlay-optin';
import { worldTime } from '#src/world/state';
import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocketServerLike } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import assert from 'node:assert/strict';
import { create, toBinary } from '@bufbuild/protobuf';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { Schema } from 'effect';

/**
The vendored Sauce widget pages (`assets/sauce/pages/`) opened in a real Chromium against a live world:
two riders keep riding through the game socket, the owner's session watches its own neighbourhood over
the event WebSocket, and the page has to paint both of them with nothing in the console, no failed
request and no 404/401 for any asset. Everything a page produces that it should not have lands in
`problems`; the last assertion of both widget cases is that this list stayed empty.

Both pages read their data from the `/api/ws/events` push, so the cases also record the frames the
page's own socket exchanged: a subscription the server silently drops shows up there.
*/

/** A chat message of Bob Fast as the world receives it. */
const chatUpdate = (text: string, time: bigint) =>
  create(WorldAttributeSchema, {
    serverRealm: 1n,
    waType: WA_TYPE.WAT_SPA,
    worldTimeBorn: time,
    worldTimeExpire: time + 60_000n,
    payload: toBinary(
      SocialPlayerActionSchema,
      create(SocialPlayerActionSchema, {
        playerId: 0n,
        toPlayerId: 0n,
        spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
        firstName: 'Bob',
        lastName: 'Fast',
        message: text,
        countryCode: 0,
      }),
    ),
  });

// Two chat messages of the same shape `chatUpdate` builds: a public one carries `toPlayerId: 0n`,
// a direct one names its recipient, and the world derives the chat log's visibility from those two
// ids (public to every viewer, direct only to sender and recipient).
function directMessage(text: string, from: number, to: number, firstName: string, lastName: string) {
  const action = create(SocialPlayerActionSchema, {
    playerId: BigInt(from),
    toPlayerId: BigInt(to),
    spaType: SocialPlayerActionType.SOCIAL_TEXT_MESSAGE,
    firstName,
    lastName,
    message: text,
    countryCode: 0,
  });

  return create(WorldAttributeSchema, {
    serverRealm: 1n,
    waType: WA_TYPE.WAT_SPA,
    worldTimeBorn: worldTime(),
    worldTimeExpire: worldTime() + 60_000n,
    waF12: 1n,
    timestamp: BigInt(Date.now()) * 1000n,
    payload: toBinary(SocialPlayerActionSchema, action),
  });
}

/** `"self"` as a base64url JSON argument of a v2 RPC path. */
const selfArgument = 'InNlbGYi';

/** What the settings-page case reads from the page about its forms. */
interface FormOrder {
  numberValue: string | null;
  rangeValue: string | null;
  firstFormHasNumber: boolean;
  hasFont: boolean;
  hasTexture: boolean;
  fontAfterFirstForm: boolean;
  textureAfterFirstForm: boolean;
}

/** The part of a `getAthleteData` answer the gauge case checks. */
const decodeAthleteData = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      success: Schema.Boolean,
      value: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            wBal: Schema.optional(Schema.NullOr(Schema.Finite)),
            athlete: Schema.optional(
              Schema.NullOr(Schema.Struct({ wPrime: Schema.optional(Schema.NullOr(Schema.Finite)) })),
            ),
          }),
        ),
      ),
    }),
  ),
);

/** The same road, direction and course the medium Sauce test rides on. */
const road = (6 << 16) | 4;

/** Packets are only usable while younger than ten seconds, so they keep coming on a timer. */
function packetOf(
  id: bigint,
  index: number,
  rider: { power: number; speed: number; heartrate: number; x: number; ahead: number; cadenceUHz?: number },
) {
  return create(PlayerStateSchema, {
    id,
    worldTime: worldTime(),
    roadTime: 100_000 + rider.ahead + index * 500,
    power: rider.power,
    speed: rider.speed,
    heartrate: rider.heartrate,
    // 1_500_000 µHz is 90 revolutions per minute; the Watching page shows it as `90`.
    cadenceUHz: rider.cadenceUHz ?? 0,
    x: rider.x + index * 4000,
    distance: index * 5,
    f19: road,
    aux3: 100 << 8,
  });
}

/** Named riders with an FTP and a weight, both alive in the world and fed fresh packets every 500 ms.
Each rider logs in only on the very first push, because logging in again would wipe the rider's
history (`World.login` deletes its `StateHistory`) and the history would never grow. `ahead` is how far
Bob rides in front of Alice in road time (500 is about 50 m: two groups; a small one puts both in one). */
async function riding(t: TestContext, ahead = 500) {
  const f = await mediumFixture(t);
  const profiles = f.effects.runSync(ProfilesService);
  const riders = [
    {
      user: f.rider,
      first: 'Alice',
      last: 'Rider',
      power: 250,
      speed: 36_000_000,
      heartrate: 140,
      x: 0,
      ahead: 0,
      cadenceUHz: 1_500_000,
    },
    { user: f.other, first: 'Bob', last: 'Fast', power: 320, speed: 38_000_000, heartrate: 150, x: ahead * 10, ahead },
  ] as const;

  for (const rider of riders) {
    const stored = f.effects.runSync(profiles.get(rider.user.player_id));

    stored.firstName = rider.first;
    stored.lastName = rider.last;
    stored.ftp = 250;
    stored.weightInGrams = 70_000;

    f.effects.runSync(profiles.save(rider.user.player_id, stored));
  }

  let sent = 0;
  const push = () => {
    for (const rider of riders) {
      const id = BigInt(rider.user.player_id);

      // Log in only once: `World.login` deletes the rider's `StateHistory`, so logging in on every
      // push would wipe the history and it would never hold more than one sample.
      if (sent === 0) {
        f.world.login(id, new Uint8Array(16));
      }

      f.world.receive(id, packetOf(id, sent, rider));
    }

    sent += 1;
  };

  push();

  const timer = setInterval(push, 500);

  t.after(() => clearInterval(timer));

  const session = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  return { f, riders, session: session.id };
}

/** The web app over a real socket, with the event WebSocket the widget pages open.

`fetch` is exactly what `serve` declares: `(request, env) => ...`. Passing the app's own bound fetch
instead of forwarding both arguments drops the `env` of every request, and the `/api/ws/events` route
answers 500 without `env[WAIT_FOR_WEBSOCKET_SYMBOL]`. */
async function serving(fetch: ((request: Request, bindings: unknown) => Promise<Response>) | undefined) {
  if (fetch === undefined) {
    throw new Error('the web app must expose a fetch');
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });

  // `serve` settles on its port asynchronously: the port is only trustworthy once listening fires.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see `upgradesOf` in main.ts
  const upgrades = wss as WebSocketServerLike;
  const { server, port } = await new Promise<{ server: Server; port: number }>((resolve) => {
    const started = serve(
      { fetch, hostname: '127.0.0.1', port: 0, websocket: { server: upgrades } },
      (info: AddressInfo) => {
        // `serve` types its server as the union of the http and http2 servers; these options build http.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const http = started as Server;

        resolve({ server: http, port: info.port });
      },
    );
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      wss.close();
      // These options build a plain http.Server; closeAllConnections is missing only from its http2 branch.
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    },
  };
}

/** Console errors and warnings, page exceptions, failed requests, HTTP responses of 400 or more, and
every request aimed at a host other than the test server (an outside host means the page phones home).
CSP refusals arrive as console errors (`Refused to ...`) and are caught by this very same hook.

The one message that never counts as a problem is `warning: Storing updated field ID: ...`: on its
very first run the Sauce Watching page writes its default data fields into `localStorage` and logs
one such warning per field (`pwr-avg`, `pwr-max`, `hr-cur`, ...). That is first-run housekeeping,
not an error. Everything else stays a problem. */
function watch(page: Page, serverHost: string) {
  const problems: Array<string> = [];
  // Every non-`data:`/`blob:` request url, so a case can assert where the page actually fetched.
  const requested: Array<string> = [];

  const push = (text: string) => {
    problems.push(text);
  };

  page.on('request', (request) => {
    const url = request.url();

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return;
    }

    requested.push(url);

    if (new URL(url).host !== serverHost) {
      push(`external request: ${url}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return;
    }

    const text = message.text();

    if (message.type() === 'warning' && text.startsWith('Storing updated field ID: ')) {
      return;
    }

    // Resource failures (a 404 image) carry no url in their text; `location` names the resource, so
    // the problem line gets it appended.
    const source = message.location().url;

    push(`${message.type()}: ${text}${source === '' ? '' : ` (${source})`}`);
  });
  page.on('pageerror', (error) => push(`pageerror: ${error}`));
  page.on('requestfailed', (request) => push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      push(`http ${response.status()}: ${response.url()}`);
    }
  });

  return { problems, requested };
}

/** What the page's own event socket sent and received: a subscription the server never answers is
visible here, and that is exactly what a page that stays empty points at. */
function traffic(page: Page) {
  const frames: Array<string> = [];

  page.on('websocket', (socket) => {
    frames.push(`opened: ${socket.url()}`);
    socket.on('framesent', (frame) => {
      frames.push(`sent: ${String(frame.payload).slice(0, 200)}`);
    });
    socket.on('framereceived', (frame) => {
      frames.push(`received: ${String(frame.payload).slice(0, 200)}`);
    });
    // Playwright names this event `socketerror`; `error` belongs to node's own sockets.
    socket.on('socketerror', (message: string) => {
      frames.push(`socket error: ${message}`);
    });
  });

  return frames;
}

/** Screenshots go to the directory named by `WIDGET_SHOTS`, and only when that variable is set. */
async function shoot(page: Page, name: string) {
  const directory = process.env.WIDGET_SHOTS;

  if (!directory) {
    return;
  }

  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

/** The text of the page as the rider sees it: elements that are not rendered are left out. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;

    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text, as the rider sees it
    return document.body.innerText;
  });
}

/** The smallest table row whose text holds `name` (compared case-insensitively, because the Sauce
styles upper-case some labels): the row of a rider on the nearby page. `''` means no row matches. */
async function rowText(page: Page, name: string): Promise<string> {
  return page.evaluate<string>(
    `(() => {
        const wanted = ${JSON.stringify(name)}.toLowerCase();
        let best = null;

        for (const el of document.querySelectorAll('tr')) {
            const text = el.innerText;

            if (text.toLowerCase().includes(wanted) && (best === null || text.length < best.length)) {
                best = text;
            }
        }

        return best ?? '';
    })()`,
  );
}

/** With `WIDGET_SHOTS` set, also dump what the page's RPCs really answered and what its socket saw, so a
failure reports status codes, RPC names and frames instead of a bare timeout. */
async function report(page: Page, label: string, frames: Array<string>) {
  if (!process.env.WIDGET_SHOTS) {
    return;
  }

  const lines = await page.evaluate(async () => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    // eslint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page, not in node
    const call = async (path: string) => {
      try {
        const response = await fetch(path);
        const body = await response.text();

        return `${path} -> ${response.status} ${body.slice(0, 200)}`;
      } catch (error) {
        return `${path} -> threw ${String(error)}`;
      }
    };

    return [
      await call('/api/rpc/v2/getNearbyData'),
      await call('/api/rpc/v2/getGroupsData'),
      await call('/api/rpc/v2/getGameConnectionStatus'),
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text, as the rider sees it
      `body text: ${document.body.innerText.slice(0, 300)}`,
    ];
  });

  process.stderr.write(`[sauce-diagnostic ${label}]\n${lines.join('\n')}\nsocket frames:\n${frames.join('\n')}\n`);
}

/** Waits until one of the fragments shows up; when none ever does, the screenshot and the full state of
the page (its text, its console problems, its socket frames) are reported with the failure. */
async function shown(
  page: Page,
  fragments: Array<string>,
  problems: Array<string>,
  frames: Array<string>,
  label: string,
) {
  try {
    await page.waitForFunction(
      (wanted: Array<string>) => {
        // Browser callback runs in the page's DOM environment.
        const { document } = globalThis;
        // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text, as the rider sees it
        const text = document.body.innerText;

        return wanted.some((x) => text.includes(x));
      },
      fragments,
      { timeout: 30_000 },
    );
  } catch (error) {
    await shoot(page, label.split(':', 1)[0] ?? label);

    const text = await visibleText(page);

    throw new Error(
      `${label}: none of ${JSON.stringify(fragments)} ever appeared.\n` +
        `page text: ${JSON.stringify(text)}\nproblems: ${JSON.stringify(problems, null, 1)}\n` +
        `socket frames:\n${frames.join('\n')}\nwaited until: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** A signed-in browser looking at one widget page of a world with two live riders, Bob `ahead` of Alice
(see `riding`). */
async function widgetPage(t: TestContext, ahead?: number) {
  const { f, riders, session } = await riding(t, ahead);

  // Every case here opens an HTML document under `/pages/*`, and those are only served to a rider who
  // opted into the Overlay (see `world/overlay-optin`): the file goes in before the server starts.
  new OverlayOptIn(f.config.storageDir).set(f.rider.player_id, true);

  const web = createWebApp(f);
  const server = await serving(async (request, bindings) => await web.fetch(request, bindings));
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } });

  // `tsx` (esbuild `keepNames`) wraps every function handed to `page.evaluate` in a `__name` helper that
  // only exists in node, so the very same spec must also survive a plain `tsc` build. The stub is added
  // as a string, because a function passed to addInitScript would itself be renamed by esbuild.
  await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((target) => target);' });

  await context.addCookies([{ name: 'zluggish_web_session', value: session, url: server.origin }]);

  const page = await context.newPage();
  const { problems, requested } = watch(page, new URL(server.origin).host);
  const frames = traffic(page);

  // The browser and the socket have to go even when the page itself failed, or the file never ends.
  // `close` is idempotent, so a case can also call it from its own `finally`.
  let closed = false;

  const close = async () => {
    if (closed) {
      return;
    }

    closed = true;
    await page.close();
    await browser.close();
    await server.close();
  };

  t.after(close);

  return {
    page,
    problems,
    requested,
    frames,
    origin: server.origin,
    close,
    f,
    // riders[0] is the signed-in owner (Alice Rider), riders[1] the neighbour (Bob Fast).
    riders,
  };
}

await test(
  'the Sauce nearby widget paints both live riders in Chromium with no page problems at all',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      await page.goto(`${origin}/pages/nearby.html`);
      // The Name column renders `fLast`: `B.Fast` for the neighbour, `A.Rider` for the owner itself.
      await shown(page, ['B.Fast', 'Bob Fast'], problems, frames, 'nearby: the neighbour');
      await shown(page, ['A.Rider', 'Alice Rider'], problems, frames, 'nearby: the owner');

      const text = await visibleText(page);

      assert.ok(text.includes('320'), `the 320 W of the neighbour is missing from: ${text}`);
      assert.ok(text.includes('250'), `the 250 W of the owner is missing from: ${text}`);

      // Row level: watts and w/kg of each rider, and the privacy of a stranger's weight.
      const bob = await rowText(page, 'Bob Fast');
      const alice = await rowText(page, 'Alice Rider');

      assert.ok(bob.includes('320'), `no 320 W in Bob's row: ${JSON.stringify(bob)}`);
      assert.ok(alice.includes('250'), `no 250 W in Alice's row: ${JSON.stringify(alice)}`);
      assert.ok(alice.includes('3.6'), `no 3.6 w/kg (250 W of a 70 kg owner) in Alice's row: ${JSON.stringify(alice)}`);
      assert.ok(
        !bob.includes('3.6') && !bob.includes('w/kg'),
        `the weight of a stranger leaked into Bob's row: ${JSON.stringify(bob)}`,
      );

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'nearby');
      await report(page, 'nearby', frames);
      throw error;
    }
  },
);

await test(
  'the Sauce groups widget shows the live pack in Chromium with no page problems at all',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      await page.goto(`${origin}/pages/groups.html`);
      // A pack bubble carries the athlete count; a lone rider bubble carries that rider's initials.
      await shown(page, ['2 Athletes', '2 athletes', 'BF', 'AR'], problems, frames, 'groups: the pack');

      // The pack header appears before the powers are painted, so wait for the watts themselves.
      await page.waitForFunction(
        () => {
          // Browser callback runs in the page's DOM environment.
          const { document } = globalThis;
          // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- the rendered text, as the rider sees it
          const text = document.body.innerText;

          return text.includes('320') && text.includes('250');
        },
        undefined,
        { timeout: 30_000 },
      );

      const text = await visibleText(page);

      assert.ok(/2 athletes/i.test(text), `no pack of two athletes is shown: ${text}`);
      assert.ok(text.includes('320'), `the 320 W of the neighbour is missing from: ${text}`);
      assert.ok(text.includes('250'), `the 250 W of the owner is missing from: ${text}`);
      assert.ok(text.includes('BF'), `Bob Fast's initials are missing from: ${text}`);
      assert.ok(text.includes('AR'), `Alice Rider's initials are missing from: ${text}`);

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'groups');
      await report(page, 'groups', frames);
      throw error;
    }
  },
);

await test(
  'the zoomed Groups view applies the shrink-with-distance rule to circles and keeps the watched one full size',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t, 30);

    try {
      await page.goto(`${origin}/pages/groups.html`);
      // A pack bubble carries the athlete count; a lone rider bubble carries that rider's initials.
      await shown(page, ['2 Athletes', '2 athletes', 'BF', 'AR'], problems, frames, 'groups zoom: the pack');

      // (1) the group is on the page; (2) clicking the bubble of the watched group zooms the view;
      // (3) the zoomed list then paints the athletes around the watched one.
      await page.locator('.position.watching .bubble').first().click();
      await page.waitForSelector('#content.zoomed .position:not(.watching) .bubble', { timeout: 30_000 });

      // The watched athlete keeps its full size; the other one, one place away, is scaled by 1 - 0.09.
      // `scale` is a transition of the bubble, so the computed value reaches 0.91 only when it ends.
      await page.waitForFunction(
        () => {
          // Browser callback runs in the page's DOM environment.
          const { document, getComputedStyle } = globalThis;
          const bubble = document.querySelector('#content.zoomed .position:not(.watching) .bubble');

          return bubble !== null && getComputedStyle(bubble).scale === '0.91';
        },
        undefined,
        { timeout: 10_000 },
      );

      const scales = await page.evaluate(() => {
        // Browser callback runs in the page's DOM environment.
        const { document, getComputedStyle } = globalThis;
        const scaleOf = (selector: string) => {
          const bubble = document.querySelector(selector);

          return bubble === null ? 'missing' : getComputedStyle(bubble).scale;
        };

        return {
          shrinking: document.documentElement.classList.contains('shrink-with-distance'),
          watching: scaleOf('#content.zoomed .position.watching .bubble'),
          other: scaleOf('#content.zoomed .position:not(.watching) .bubble'),
        };
      });

      assert.equal(scales.shrinking, true, 'the shrink setting is on by default');
      assert.ok(['none', '1'].includes(scales.watching), `the watched circle is scaled: ${scales.watching}`);
      assert.equal(Number(scales.other), 0.91, `the other circle is not shrunk: ${scales.other}`);

      await shoot(page, 'groups-zoomed');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'groups-zoomed');
      await report(page, 'groups-zoomed', frames);
      throw error;
    }
  },
);

await test(
  'the Sauce watching widget paints the owner power, heart-rate and cadence in Chromium with no page problems at all',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      await page.goto(`${origin}/pages/watching.html`);
      // The default screen shows `pwr-cur`, `pwr-avg` and `pwr-max` of the owner: 250 W every packet.
      await shown(page, ['250'], problems, frames, 'watching: the owner power');

      const text = await visibleText(page);

      assert.ok(text.includes('250'), `no 250 W of the owner is shown: ${text}`);
      assert.ok(text.includes('140'), `no 140 bpm heart-rate of the owner is shown: ${text}`);
      assert.ok(text.includes('90'), `no 90 rpm cadence of the owner is shown: ${text}`);

      const occurrences = text.split('250').length - 1;

      assert.ok(
        occurrences >= 3,
        `cur, avg and max all being 250 W means at least three hits, found ${occurrences} in: ${text}`,
      );
      assert.ok(!text.includes('NaN'), `a NaN is rendered on the page: ${text}`);
      assert.ok(!text.includes('undefined'), `an undefined is rendered on the page: ${text}`);

      await shoot(page, 'watching');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'watching');
      await report(page, 'watching', frames);
      throw error;
    }
  },
);

await test(
  'the Sauce chat page shows history, live messages and private ones in Chromium with no page problems at all',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin, f, riders } = await widgetPage(t);
    const ownerId = riders[0].user.player_id;
    const otherId = riders[1].user.player_id;

    // The history is read once at start-up through `getChatHistory`, so this one is enqueued BEFORE
    // the page opens: only what the world already held can reach the page that way.
    f.world.enqueue(chatUpdate('Earlier hello from Bob', worldTime()), [BigInt(ownerId), BigInt(otherId)]);

    try {
      await page.goto(`${origin}/pages/chat.html`);
      await shown(page, ['Earlier hello from Bob'], problems, frames, 'chat: the history');

      // A live public message arrives on the `chat` event of the page's own socket.
      f.world.enqueue(chatUpdate('Live hello from Bob', worldTime()), [BigInt(ownerId), BigInt(otherId)]);
      await shown(page, ['Live hello from Bob'], problems, frames, 'chat: the live message');

      // A direct message for the owner: visible to the owner, and its entry carries the `dm` class.
      f.world.enqueue(directMessage('Private note for Alice', otherId, ownerId, 'Bob', 'Fast'), [
        BigInt(ownerId),
        BigInt(otherId),
      ]);
      await shown(page, ['Private note for Alice'], problems, frames, 'chat: the direct message');

      const dm = await page.evaluate(() => {
        // Browser callback runs in the page's DOM environment.
        const { document } = globalThis;

        for (const entry of document.querySelectorAll('.entry')) {
          if ((entry.querySelector('.message')?.textContent ?? '').includes('Private note for Alice')) {
            return entry.className;
          }
        }

        return '';
      });

      assert.ok(dm.includes('dm'), `the direct message entry does not carry the dm class: ${JSON.stringify(dm)}`);

      // The sender name renders as `Bob Fast` in the entry header.
      const text = await visibleText(page);

      assert.ok(text.includes('Bob Fast'), `the sender name Bob Fast is missing from: ${text}`);

      // A direct message between two OTHER riders never reaches the owner's page at all.
      f.world.enqueue(directMessage('Secret between others', 7001, 7002, 'Carl', 'Quiet'), [7001n, 7002n]);
      await page.waitForTimeout(3000);

      const after = await visibleText(page);

      assert.ok(
        !after.includes('Secret between others'),
        `a private message of two other riders leaked onto the owner's page: ${after}`,
      );

      await shoot(page, 'chat');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'chat');
      await report(page, 'chat', frames);
      throw error;
    }
  },
);

await test(
  'the Sauce chat settings page opens for the owner in Chromium with no page problems at all',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      const response = await page.goto(`${origin}/pages/chat-settings.html`);

      assert.equal(response?.status(), 200);

      const text = await visibleText(page);

      assert.ok(text.length > 0, 'the chat settings page renders no text at all');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'chat-settings');
      await report(page, 'chat-settings', frames);
      throw error;
    }
  },
);

await test(
  'the Nearby settings fields are listed alphabetically per group and carry no trademark marks',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      const response = await page.goto(`${origin}/pages/nearby-settings.html`);

      assert.equal(response?.status(), 200);
      await page.waitForSelector('.field-group .field key', { state: 'attached', timeout: 30_000 });

      const { groups, text } = await page.evaluate<{ groups: Array<Array<string>>; text: string }>(
        `(() => {
            const groups = [...document.querySelectorAll('.field-group')].map(
                (group) => [...group.querySelectorAll('.field key')].map((key) => key.textContent.trim()),
            );

            return { groups, text: document.body.innerText };
        })()`,
      );

      assert.ok(
        groups.length >= 3,
        `expected at least 3 field groups, saw ${groups.length}: ${JSON.stringify(groups)}`,
      );

      for (const labels of groups) {
        assert.deepEqual(
          labels,
          [...labels].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })),
          `field group is not sorted alphabetically: ${JSON.stringify(labels)}`,
        );
      }

      const flat = groups.flat();

      for (const wanted of ['Load', 'Intensity', 'Normalized Power']) {
        assert.ok(flat.includes(wanted), `the flattened field labels ${JSON.stringify(flat)} miss '${wanted}'`);
      }

      assert.ok(
        flat.every((label) => !label.includes('®')),
        `a field label carries a trademark mark: ${JSON.stringify(flat)}`,
      );
      assert.ok(!text.includes('®'), 'the page text carries a trademark mark');

      await shoot(page, 'nearby-settings');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'nearby-settings');
      await report(page, 'nearby-settings', frames);
      throw error;
    }
  },
);

await test(
  'a settings page keeps its own form first: the injected Font and Texture sections come after it and the stored values are shown',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      // The window's own settings store lives in `localStorage` under `<windowId>-<settingsKey>`, so the
      // seeded values have to be there before the page script ever runs.
      await page.addInitScript({
        content: "localStorage.setItem('regtest1-groups-settings-v6', JSON.stringify({labelAngle: 33}));",
      });

      const response = await page.goto(`${origin}/pages/groups-settings.html?windowId=regtest1`);

      assert.equal(response?.status(), 200);
      await page.waitForSelector('.window-font-settings', { state: 'attached', timeout: 30_000 });
      await page.waitForSelector('.window-texture-settings', { state: 'attached', timeout: 30_000 });

      // (a) both twins of the stored `labelAngle` show the stored value,
      // (b) the FIRST form of the document is the page's own form, holding that input,
      // (c) both injected sections sit after that form in document order.
      const state = await page.evaluate<FormOrder>(
        `(() => {
            const number = document.querySelector('input[type=number][name="labelAngle"]');
            const range = document.querySelector('input[type=range][name="labelAngle"]');
            const firstForm = document.querySelector('form');
            const font = document.querySelector('.window-font-settings');
            const texture = document.querySelector('.window-texture-settings');
            const after = (node) =>
                node !== null &&
                (firstForm.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

            return {
                numberValue: number === null ? null : number.value,
                rangeValue: range === null ? null : range.value,
                firstFormHasNumber: number !== null && firstForm !== null && firstForm.contains(number),
                hasFont: font !== null,
                hasTexture: texture !== null,
                fontAfterFirstForm: after(font),
                textureAfterFirstForm: after(texture),
            };
        })()`,
      );

      assert.equal(state.numberValue, '33', `the number input does not show the stored 33: ${JSON.stringify(state)}`);
      assert.equal(state.rangeValue, '33', `the range input does not show the stored 33: ${JSON.stringify(state)}`);
      assert.ok(
        state.firstFormHasNumber,
        `the first form of the page is not the page's own settings form: ${JSON.stringify(state)}`,
      );
      assert.ok(state.hasFont, 'there is no .window-font-settings element on the page');
      assert.ok(state.hasTexture, 'there is no .window-texture-settings element on the page');
      assert.ok(
        state.fontAfterFirstForm,
        `the Font section comes before the page's own form: ${JSON.stringify(state)}`,
      );
      assert.ok(
        state.textureAfterFirstForm,
        `the Texture section comes before the page's own form: ${JSON.stringify(state)}`,
      );

      await shoot(page, 'groups-settings');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'groups-settings');
      await report(page, 'groups-settings', frames);
      throw error;
    }
  },
);

/** `traffic` keeps received frames as strings like `received: {...}`. The payload is cut at 200
characters so the JSON often ends mid-object, but the top-level `type` and the head of `data`
always survive, so both markers are matched as plain text instead of a full `JSON.parse`. */
function watchingEventOf(frames: Array<string>, athleteId: number) {
  const watching = frames.find(
    (frame) =>
      frame.startsWith('received: ') &&
      frame.includes('"type":"event"') &&
      frame.includes(`"athleteId":${athleteId}`) &&
      frame.includes('"watching":true'),
  );

  return watching ?? null;
}

/** The Overview status bar in a real browser. Its default fields (`overview.mjs` `buildLayout`) are
Ride Ons, Energy (kJ), NP and W'bal; the world does not yet produce ride-ons, NP or W'bal, and a
fresh ride has no energy either, so the bar correctly shows `0`, `0`, `0` and `-`. What this case
proves is that the page loads, paints its four default fields, hears that the overlay windows are
visible (so it never greys itself out), receives the live `athlete/watching` event of the owner
over its own event socket, and keeps the buttons of the Analysis, Athletes and Events windows hidden,
because those pages are not shipped. */
await test(
  'the Sauce overview status bar shows live owner data and never greys itself out in Chromium',
  { timeout: 120_000 },
  async (t) => {
    const { page, problems, frames, origin, riders } = await widgetPage(t);
    const ownerId = riders[0].user.player_id;

    try {
      await page.goto(`${origin}/pages/overview.html`);

      // First proof: the bar holds its four default field names (they render even without data).
      await shown(page, ['Ride Ons'], problems, frames, 'overview: the default bar');
      await shown(page, ['Energy', 'NP', "W'bal"], problems, frames, 'overview: the default fields');

      // Second proof: the fields may all legitimately read `0` or `-` in a fresh ride, but the live
      // `athlete/watching` event of the owner (rider 1) has to reach the page's own event socket.
      // Poll the collected frames in the same deterministic style the other waits use.
      const deadline = Date.now() + 30_000;

      while (watchingEventOf(frames, ownerId) === null) {
        if (Date.now() >= deadline) {
          throw new Error(
            `no received athlete/watching event for athleteId ${ownerId} within 30s.\n` +
              `socket frames:\n${frames.join('\n')}`,
          );
        }

        await new Promise((done) => {
          setTimeout(done, 250);
        });
      }

      // Zluggish always reports the overlay windows as visible (RPC and one-shot event), so the page
      // never adds its `windows-hidden` class to the root element.
      const hidden = await page.evaluate(() =>
        globalThis.document.documentElement.classList.contains('windows-hidden'),
      );

      assert.equal(hidden, false, 'the root element carries the windows-hidden class');

      // The Analysis, Athletes and Events pages are not shipped, so their buttons stay hidden.
      const buttons = await page
        .locator('.controls .button[data-settings-key]')
        .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).display));

      assert.deepEqual(
        buttons,
        ['none', 'none', 'none'],
        `Analysis, Athletes and Events are hidden: ${JSON.stringify(buttons)}`,
      );

      const text = await visibleText(page);

      assert.ok(!text.includes('NaN'), `a NaN is rendered on the page: ${text}`);
      assert.ok(!text.includes('undefined'), `an undefined is rendered on the page: ${text}`);

      await shoot(page, 'overview');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'overview');
      await report(page, 'overview', frames);
      throw error;
    }
  },
);

/** The text of the gauge chart. The gauges draw with Apache ECharts' SVG renderer, so their numbers
are `<text>` elements inside `.gauge svg`, which `document.body.innerText` does not contain. The
count is checked first so a page that has not painted the chart yet returns `''` instead of throwing. */
async function gaugeText(page: Page): Promise<string> {
  if ((await page.locator('.gauge svg').count()) === 0) {
    return '';
  }

  return (await page.locator('.gauge svg').textContent()) ?? '';
}

/** Polls the gauge text every 250 ms for up to 30 s (the same deterministic deadline loop the
Overview test uses) until it holds `expected`; otherwise throws with the label, the expected text
and the last text seen. */
async function gaugeShows(page: Page, expected: string, label: string) {
  const deadline = Date.now() + 30_000;
  let text = '';

  while (!text.includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}: the gauge text never showed ${JSON.stringify(expected)}, last seen: ${text}`);
    }

    await new Promise((done) => {
      setTimeout(done, 250);
    });

    text = await gaugeText(page);
  }
}

await test(
  'the Sauce gauge pages draw the live owner values in Chromium with no page problems at all',
  { timeout: 180_000 },
  async (t) => {
    const { page, problems, frames, origin } = await widgetPage(t);

    try {
      // One signed-in page walks through every gauge in turn, so no second browser is needed.
      type GaugeCase = { name: string; expected?: string };
      const cases: Array<GaugeCase> = [
        // The owner rides at 250 W, 140 bpm and 90 rpm (cadenceUHz 1_500_000) in the fixture, and
        // its FTP there is 250 W too (see `riding`).
        { name: 'power', expected: '250' },
        { name: 'hr', expected: '140' },
        { name: 'cadence', expected: '90' },
        // The fixture feeds 36_000_000 mm/h (36 km/h) and the page prints km/h with one decimal,
        // so the text has to hold `36.0`; the static title `Speed` would match immediately and
        // prove nothing.
        { name: 'pace', expected: '36.0' },
        // The owner rides at exactly its own 250 W FTP, so the Skiba model (CP = FTP) correctly
        // keeps the balance at the full 20 kJ capacity: power equal to CP changes nothing. The
        // number on the gauge is not asserted because the gauge animates toward its value (a
        // mid-animation frame could show any number), so the case only waits until the text holds
        // a `kJ` unit and below proves the exact data behind the render with an RPC. The draining
        // itself is proven with exact numbers in `tests/medium/widget-api.spec.ts` (the test
        // 'the W balance of the watched rider is its own, every other rider is answered without
        // one').
        { name: 'wbal', expected: 'kJ' },
        // The draft chart has no fixed number to hunt for: it must simply exist.
        { name: 'draft', expected: '' },
      ];

      // The settings link of the power gauge, remembered during the loop so the settings page is
      // reached by following a REAL link instead of a hand-written URL.
      let powerSettingsHref: string | undefined;

      for (const gauge of cases) {
        await page.goto(`${origin}/pages/gauges/${gauge.name}.html`);

        if (gauge.expected === '') {
          // Expected text `''` would pass instantly, so these two wait on the SVG existing.
          const deadline = Date.now() + 30_000;

          while ((await page.locator('.gauge svg').count()) === 0) {
            if (Date.now() >= deadline) {
              throw new Error(`gauge ${gauge.name}: no .gauge svg appeared within 30s`);
            }

            await new Promise((done) => {
              setTimeout(done, 250);
            });
          }
        } else {
          await gaugeShows(page, gauge.expected ?? '', `gauge ${gauge.name}`);
        }

        if (gauge.name === 'wbal') {
          // The number on the gauge is not asserted: the gauge counts up toward its real value, so
          // a polled frame can show any number mid-animation and prove nothing. What is asserted is
          // the DATA behind the render: the owner's own record says `wPrime === 20_000` and
          // `wBal === 20_000` — a rider at exactly its FTP keeps the full balance (CP = FTP
          // changes nothing in the Skiba model). The draining is proven with exact numbers in
          // `tests/medium/widget-api.spec.ts` (the test 'the W balance of the watched rider is
          // its own, every other rider is answered without one').
          const record = decodeAthleteData(
            await page.evaluate(async (argument: string) => {
              const response = await fetch(`/api/rpc/v2/getAthleteData/${argument}`);

              return response.text();
            }, selfArgument),
          );

          assert.equal(record.success, true, `getAthleteData(self) failed: ${JSON.stringify(record)}`);
          assert.equal(
            record.value?.athlete?.wPrime,
            20_000,
            `the owner wPrime is not 20 kJ: ${JSON.stringify(record)}`,
          );
          assert.equal(
            record.value?.wBal,
            20_000,
            `the balance of a rider at exactly its FTP is not the full 20 kJ: ${JSON.stringify(record)}`,
          );
        }

        await shoot(page, `gauge-${gauge.name}`);

        // Every gauge page links to the shared settings page and the link has to carry the
        // `t=<gauge>` parameter, because without it settings.html throws
        // `Cannot read properties of undefined (reading 'defaultSettings')`.
        const href = await page.locator('a.open-settings').getAttribute('href');

        assert.ok(href !== null, `gauge ${gauge.name}: the settings link has no href`);
        assert.ok(
          href.includes(`t=${gauge.name}`),
          `gauge ${gauge.name}: the settings link does not carry the gauge type, href is ${JSON.stringify(href)}`,
        );

        if (gauge.name === 'power') {
          powerSettingsHref = href;
        }
      }

      // settings.html resolves its fields through the same module-level config, so the type has to
      // come from the query here too (see the loop above). Follow the real settings link of the
      // power gauge instead of a hand-written URL.
      assert.ok(powerSettingsHref !== undefined, 'the power gauge settings link href was not captured');
      await page.goto(new URL(powerSettingsHref, `${origin}/pages/gauges/power.html`).href);

      const settingsDeadline = Date.now() + 30_000;

      while ((await page.locator('form').count()) === 0) {
        if (Date.now() >= settingsDeadline) {
          throw new Error('gauge settings: no form appeared within 30s');
        }

        await new Promise((done) => {
          setTimeout(done, 250);
        });
      }

      assert.ok((await page.locator('form').count()) > 0, 'the gauge settings page shows no form');

      assert.deepEqual(problems, []);
    } catch (error) {
      await shoot(page, 'gauge');
      await report(page, 'gauges', frames);
      throw error;
    }
  },
);

await test(
  'an anonymous widget page lands on the sign-in page, and its neighbourhood RPC still demands a signed-in rider',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const server = await serving(async (request, bindings) => await web.fetch(request, bindings));
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 700, height: 900 } });
    const page = await context.newPage();

    try {
      // Chromium follows the 302, so the browser ends up on the web app root; the SPA may then
      // client-side redirect '/' to '/setup' on a fresh database, so assert the server-side
      // redirect itself instead of the final (timing-dependent) browser URL.
      const response = await page.goto(`${server.origin}/pages/nearby.html`);

      const redirect = response?.request().redirectedFrom();

      assert.ok(redirect, 'the widget request was redirected');
      assert.equal(new URL(redirect.url()).pathname, '/pages/nearby.html');
      const redirected = await redirect.response();

      assert.equal(redirected?.status(), 302);
      assert.equal(new URL(response!.url()).pathname, '/');

      const rpc = await page.request.get(`${server.origin}/api/rpc/v2/getNearbyData`);

      assert.equal(rpc.status(), 401);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
