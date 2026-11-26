import { WebSessionsService } from '#src/services/web-session.service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebApp } from '#src/http/web-app';
import { packageRoot } from '#src/config/load';
import { mediumFixture } from '#tests/medium/support';
import { OverlayOptIn } from '#src/world/overlay-optin';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
The vendored Sauce overlay pages are static files served from `/pages/*` and `/shared/*`.

HTML documents of `/pages/*` demand a session: an anonymous request is redirected (302, `no-store`) to
`/`, the web app sign-in page, because a signed-out widget would otherwise sit empty with only 401s in
the console. Assets (scripts, styles, images, fonts, templates) and everything under `/shared/*` carry
no rider data and stay anonymous; those requests below are sent WITHOUT cookies on purpose.
*/

const origin = 'http://local:8080';

const get = (app: ReturnType<typeof createWebApp>, path: string, init: RequestInit = {}) =>
  app.request(`${origin}${path}`, init);

/** The overlay opt-in of the fixture's rider, written into the very file store the web app of this
fixture reads (`<storageDir>/overlay-optin.json`). The `/pages/*` HTML guard serves only opted-in
riders, so a signed-in request below that expects a page needs this first. */
function optInOverlay(f: Awaited<ReturnType<typeof mediumFixture>>, rider = f.rider) {
  new OverlayOptIn(f.config.storageDir).set(rider.player_id, true);
}

/** A signed-in web session of the fixture's rider: its cookie value, a `get` carrying it, and its
header object for requests that build their own `headers` (e.g. a custom `Host`). */
function signedIn(t: Awaited<ReturnType<typeof mediumFixture>>) {
  // The pages below are HTML documents of `/pages/*`: only an opted-in rider is served, everybody else
  // is redirected to `/overlay` (the opt-in file is written before the first request reaches the app).
  optInOverlay(t);
  const sessions = t.effects.runSync(WebSessionsService);
  const { id } = t.effects.runSync(sessions.create(t.accounts.identityOf(t.rider)));
  const cookie = `zluggish_web_session=${id}`;

  const get = (app: ReturnType<typeof createWebApp>, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);

    headers.set('Cookie', cookie);

    return app.request(`${origin}${path}`, { ...init, headers });
  };

  return { cookie, get, headers: { Cookie: cookie } };
}

await test(
  'the HTML pages are served to a signed-in rider and their assets anonymously with the right types and cache',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const served: Array<[string, string]> = [
      ['/pages/groups.html', 'text/html'],
      ['/pages/groups-settings.html', 'text/html'],
      ['/pages/nearby.html', 'text/html'],
      ['/pages/nearby-settings.html', 'text/html'],
      ['/pages/src/boot-groups.mjs', 'text/javascript'],
      ['/pages/src/common.mjs', 'text/javascript'],
      ['/shared/sauce/index.mjs', 'text/javascript'],
      ['/shared/curves.mjs', 'text/javascript'],
      ['/pages/deps/src/sentry.mjs', 'text/javascript'],
      ['/pages/css/common.css', 'text/css'],
      ['/pages/fonts/Saira.woff2', 'font/woff2'],
      ['/pages/images/favicon.png', 'image/png'],
      ['/pages/images/fa/search-minus-duotone.svg', 'image/svg+xml'],
      ['/pages/templates/watching-screen-layout.html.tpl', 'text/plain'],
      ['/shared/deps/data/countries.json', 'application/json'],
      ['/pages/groups-manifest.json', 'application/json'],
    ];

    for (const [path, type] of served) {
      const response = path.endsWith('.html') ? await auth(web, path) : await get(web, path);

      assert.equal(response.status, 200, `${path} must be served (html to a signed-in rider, assets anonymously)`);
      assert.ok(
        (response.headers.get('content-type') ?? '').includes(type),
        `${path}: ${response.headers.get('content-type')}`,
      );

      const cache = response.headers.get('cache-control') ?? '';

      if (path.endsWith('.woff2') || path.endsWith('.webp')) {
        assert.match(cache, /max-age=3600/, path);
      } else {
        assert.match(cache, /no-cache/, path);
      }
    }
  },
);

/** Local references of one fetched document: HTML attributes, module specifiers and CSS `url(...)`. */
function references(url: string, body: string) {
  const extension = extname(new URL(url).pathname);
  const specs: Array<string> = [];

  switch (extension) {
    case '.html':
    case '.tpl': {
      for (const match of body.matchAll(/(?:\bsrc|\bhref)\s*=\s*"([^"]*)"/gi)) {
        const spec = match[1]!;

        // Templates embed `{{...}}` expressions, and `profile.html?...` opens a Sauce window, not a
        // file. The `analysis/athletes/events.html?...` hrefs are the hidden window buttons of
        // `overview.html`: they open pages of Sauce's Electron app that Zluggish does not ship.
        const windowPages = ['profile.html', 'analysis.html', 'athletes.html', 'events.html'];

        if (spec.includes('{{') || windowPages.some((page) => spec.startsWith(page))) {
          continue;
        }

        // A `.tpl` lives under `pages/templates/` but its paths are relative to `pages/`, so it is
        // fetched as a closure root with `/pages/` as its base.
        specs.push(extension === '.tpl' ? `/pages/${spec.replace(/^\.?\//, '')}` : spec);
      }
      break;
    }
    case '.mjs':
    case '.js': {
      for (const match of body.matchAll(
        /(?:\bfrom|\bimport)\s*\(?\s*'([^']*)'|(?:\bfrom|\bimport)\s*\(?\s*"([^"]*)"/g,
      )) {
        const spec = match[1] ?? match[2]!;

        // A module specifier never holds whitespace: `=== 'profile-import') {` reads to this regex as an
        // import of everything up to the next quote, and only a real specifier may enter the closure.
        if (!/\s/.test(spec)) {
          specs.push(spec);
        }
      }
      break;
    }
    case '.css': {
      for (const match of body.matchAll(/url\(\s*['"]?([^'")]+?)\s*['"]?\s*\)/g)) {
        // `url(#id)` / `url(%23id)` inside an inline SVG texture points at an element of that SVG, not at a file.
        if (!match[1]!.startsWith('#') && !match[1]!.startsWith('%23')) {
          specs.push(match[1]!);
        }
      }
      break;
    }
    default: {
      break;
    }
  }

  const local: Array<string> = [];

  for (const spec of specs) {
    if (/^(?:https?:|data:|#)/.test(spec) || spec.startsWith('/api/')) {
      continue;
    }

    try {
      // `?v=...` cache busters and `#fragments` are dropped: only the path is requested.
      const resolved = new URL(spec, url);

      if (resolved.pathname.startsWith('/pages/') || resolved.pathname.startsWith('/shared/')) {
        local.push(resolved.pathname);
      }
    } catch {
      // A reference the URL parser cannot read is not a file the page can load.
    }
  }

  return local;
}

/**
The chart library (`pages/deps/src/echarts.mjs`) IS vendored, because `elevation.mjs` imports it
statically and the Watching page does not start without it (see `assets/sauce/ATTRIBUTION.md`).
Nothing referenced may 404.
*/
await test(
  'the eighteen Overlay HTML pages close over every file they reference, and the app serves all of them',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const queue = [
      `${origin}/pages/groups.html`,
      `${origin}/pages/groups-settings.html`,
      `${origin}/pages/nearby.html`,
      `${origin}/pages/nearby-settings.html`,
      `${origin}/pages/watching.html`,
      `${origin}/pages/watching-settings.html`,
      `${origin}/pages/chat.html`,
      `${origin}/pages/chat-settings.html`,
      `${origin}/pages/overview.html`,
      `${origin}/pages/gauges/power.html`,
      `${origin}/pages/gauges/hr.html`,
      `${origin}/pages/gauges/cadence.html`,
      `${origin}/pages/gauges/pace.html`,
      `${origin}/pages/gauges/wbal.html`,
      `${origin}/pages/gauges/draft.html`,
      `${origin}/pages/gauges/settings.html`,
      `${origin}/pages/mods.html`,
      // The Watching layout template is fetched at run time by `fetch`, so a static scan misses it: it
      // must be an extra closure root of its own.
      `${origin}/pages/templates/watching-screen-layout.html.tpl`,
    ];
    const bodies = new Map<string, string>();
    const missing: Array<string> = [];

    while (queue.length > 0) {
      const url = queue.shift()!;

      if (bodies.has(url)) {
        continue;
      }

      const response = await auth(web, new URL(url).pathname);

      if (response.status !== 200) {
        missing.push(new URL(url).pathname);

        continue;
      }

      bodies.set(url, await response.text());

      for (const path of references(url, bodies.get(url)!)) {
        const next = `${origin}${path}`;

        if (!bodies.has(next)) {
          queue.push(next);
        }
      }
    }

    assert.deepEqual(missing, [], 'every referenced file must be served');

    const paths = bodies
      .keys()
      .map((url) => new URL(url).pathname)
      .toArray()
      .sort();

    // The guard for future updates: a vendored page that starts referencing a file we did not vendor
    // fails above, and a closure that suddenly shrinks (a page losing its wiring) fails here.
    // The closure currently holds 106 files (echarts, the chat pages, the Overview bar, the gauges and
    // the Profile page included).
    assert.ok(
      paths.length >= 103,
      `the closure should hold at least 103 files, got ${paths.length}: ${paths.join(', ')}`,
    );
    assert.ok(paths.includes('/pages/deps/src/sentry.mjs'), 'the dynamic sentry.mjs import must be vendored as a stub');
    assert.ok(
      paths.includes('/pages/deps/src/echarts.mjs'),
      'the statically imported echarts.mjs must be vendored: the Watching page needs it to start',
    );
    assert.ok(
      paths.includes('/pages/templates/watching-screen-layout.html.tpl'),
      'the run-time-fetched Watching template must be part of the closure',
    );
  },
);

await test(
  'traversal, directories, missing files and malformed requests under /pages and /shared are not found',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const rejected = [
      '/pages/../../package.json',
      '/pages/%2e%2e/%2e%2e/package.json',
      '/pages/..%2f..%2fpackage.json',
      // Inside `shared/` a `..` may not climb back to the vendored root and reach ATTRIBUTION.md.
      '/shared/%2e%2e%2fATTRIBUTION.md',
      '/pages/src',
      '/pages/',
      '/shared/%00',
      '/pages/%E0%A4%A',
    ];

    for (const path of rejected) {
      const response = await get(web, path);

      assert.equal(response.status, 404, path);
    }

    // A missing `.html` page is redirected to sign-in for an anonymous rider but answers a plain 404
    // to a signed-in one: the redirect happens before the file is even looked at.
    const missing = await get(web, '/pages/nie-ma.html', { redirect: 'manual' });

    assert.equal(missing.status, 302, '/pages/nie-ma.html anonymously must go to sign-in');
    assert.equal(missing.headers.get('location'), '/');

    // A signed-in rider still gets a plain 404 for a missing page that is not one of the two we
    // answer with the "not part of Zluggish Overlay" notice.
    for (const path of ['/pages/nie-ma.html', '/pages/does-not-exist.html']) {
      const absent = await auth(web, path);

      assert.equal(absent.status, 404, path);
    }

    const posted = await web.request(`${origin}/pages/groups.html`, { method: 'POST' });

    assert.notEqual(posted.status, 200);
  },
);

await test(
  'an anonymous HTML page under /pages is redirected to the sign-in page without following the redirect',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);

    const response = await get(web, '/pages/chat.html', { redirect: 'manual' });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  },
);

await test(
  'a signed-in rider gets the chat page as HTML with the page CSP, while its assets stay anonymous',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const page = await auth(web, '/pages/chat.html');

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src\s+'self';/);
    assert.match(page.headers.get('cache-control') ?? '', /no-cache/);

    for (const path of ['/pages/src/common.mjs', '/pages/css/common.css']) {
      const asset = await get(web, path);

      assert.equal(asset.status, 200, `${path} must stay anonymous`);
    }
  },
);

await test(
  'the Profile Avatar page we do not ship answers the signed-in rider with a notice, and an anonymous one with the redirect',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    for (const path of ['/pages/profile-avatar.html']) {
      const notice = await auth(web, path);

      assert.equal(notice.status, 200, path);
      assert.match(notice.headers.get('content-type') ?? '', /text\/html/, path);
      assert.match(notice.headers.get('cache-control') ?? '', /no-cache/, path);
      assert.match(notice.headers.get('content-security-policy') ?? '', /script-src\s+'self';/, path);

      const body = await notice.text();

      assert.match(body, /This page is not part of Zluggish Overlay yet/, path);
      assert.match(body, /<!doctype html>/i, path);
      assert.match(body, /charset/i, path);
      assert.match(body, /viewport/i, path);
      assert.match(body, /<title>Not available<\/title>/, path);
      assert.ok(!/<script/i.test(body), `${path}: the notice must carry no scripts`);
      assert.match(body, /#1b1b1f/, path);

      const anonymous = await get(web, path, { redirect: 'manual' });

      assert.equal(anonymous.status, 302, path);
      assert.equal(anonymous.headers.get('location'), '/', path);
    }
  },
);

await test('no page policy lets an image load from another host', { timeout: 60_000 }, async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  for (const path of ['/pages/profile.html', '/pages/nearby.html']) {
    const response = await auth(web, path);

    assert.equal(response.status, 200, path);

    const policy = response.headers.get('content-security-policy') ?? '';

    assert.match(policy, /img-src\s+'self'\s+data:;/, path);
    assert.ok(!policy.includes('wikimedia'), `${path}: ${policy}`);
  }
});

await test(
  'HTML pages carry their own CSP that keeps scripts to self and lets the Sauce socket of this host',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth, headers: authHeaders } = signedIn(f);

    const scriptSelf = /script-src\s+[^;]*'self'[^;]*;/;
    const policyOf = async (url: string, host?: string) => {
      const response = await web.request(url, { headers: host ? { Host: host, ...authHeaders } : authHeaders });

      assert.equal(response.status, 200);

      return response.headers.get('content-security-policy') ?? '';
    };

    const plain = await policyOf(`${origin}/pages/groups.html`);

    assert.match(plain, scriptSelf);
    assert.doesNotMatch(plain, /script-src\s+[^;]*unsafe-inline/);
    assert.ok(!plain.includes('youtube'), plain);
    assert.match(plain, /connect-src\s+'self'/);

    const hosted = await policyOf(`${origin}/pages/groups.html`, 'local:8080');

    assert.match(hosted, /connect-src\s+'self'\s+ws:\/\/local:8080/);

    const secure = await policyOf('https://local:8080/pages/groups.html', 'local:8080');

    assert.match(secure, /connect-src\s+'self'\s+wss:\/\/local:8080/);

    // A `Host` header that is not shaped like a host must never reach the policy.
    for (const host of ['evil.example;x=y', 'a b', 'ev"il']) {
      const hostile = await policyOf(`${origin}/pages/groups.html`, host);

      assert.doesNotMatch(hostile, /evil|ev"il|x=y/, host);
      assert.match(hostile, /connect-src\s+'self'\s*;/);
    }

    const stylesheet = await get(web, '/pages/css/common.css');

    assert.match(stylesheet.headers.get('cache-control') ?? '', /no-cache/);

    const font = await get(web, '/pages/fonts/Saira.woff2');

    assert.match(font.headers.get('cache-control') ?? '', /max-age=3600/);

    const html = await auth(web, '/pages/nearby.html');

    assert.match(html.headers.get('cache-control') ?? '', /no-cache/);
    assert.match(html.headers.get('content-security-policy') ?? '', scriptSelf);

    // The Watching pages compile template functions via `new Function`, so ONLY those pages get
    // `unsafe-eval`.
    for (const path of ['/pages/watching.html', '/pages/watching-settings.html']) {
      const policy = await policyOf(`${origin}${path}`);

      assert.ok(policy.includes("script-src 'self' 'unsafe-eval';"), path);
      assert.doesNotMatch(policy, /script-src\s+[^;]*unsafe-inline/, path);
    }

    for (const path of ['/pages/groups.html', '/pages/nearby.html', '/pages/overview.html']) {
      const policy = await policyOf(`${origin}${path}`);

      assert.ok(policy.includes("script-src 'self';"), path);
      assert.doesNotMatch(policy, /script-src\s+[^;]*unsafe-(eval|inline)/, path);
    }
  },
);

/**
Update guard: whatever HTML pages under `assets/sauce/pages` declare `'unsafe-eval'` in their own
meta-CSP must be EXACTLY the set of pages our server grants it to — never more, never less.
*/
await test(
  'the CSP `unsafe-eval` exception matches exactly the pages whose own HTML declares it',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const pagesRoot = resolve(packageRoot(), '../assets/sauce/pages');
    const declaring = new Set(
      readdirSync(pagesRoot)
        .filter((name) => name.endsWith('.html'))
        .filter((name) => readFileSync(resolve(pagesRoot, name), 'utf8').includes("'unsafe-eval'"))
        .map((name) => `/pages/${name}`),
    );

    assert.ok(declaring.size > 0, 'some vendored page is expected to declare `unsafe-eval`');

    for (const name of readdirSync(pagesRoot)
      .filter((name) => name.endsWith('.html'))
      .sort()) {
      const path = `/pages/${name}`;
      const response = await auth(web, path);
      const policy = response.headers.get('content-security-policy') ?? '';

      assert.equal(policy.includes("script-src 'self' 'unsafe-eval';"), declaring.has(path), path);
    }
  },
);

/**
Every URL literal in the vendored pages, reviewed one by one. A page must never phone a third party
on its own: the only hosts allowed here are comment links, links a person clicks, namespace strings
and the Sauce time server that the Zluggish patch (`assets/sauce/ATTRIBUTION.md`, change 3) keeps
unreachable. A future update that adds a call outwards shows up here as an unknown pair.
*/
const reviewed = [
  { file: 'pages/css/chat.css', host: 'bugs.chromium.org', why: 'a link inside a comment' },
  { file: 'pages/src/common.mjs', host: 'discord.com', why: 'a link a person clicks in the About text' },
  { file: 'pages/src/common.mjs', host: 'github.com', why: 'a link a person clicks in the About text' },
  {
    file: 'pages/src/chat.mjs',
    host: 'gravatar.com',
    why: 'only the `?test` mock-message generator, and the page policy blocks it',
  },
  {
    file: 'pages/src/chat.mjs',
    host: 'raw.githubusercontent.com',
    why: 'only the `?test` mock-message generator, and the page policy blocks it',
  },
  { file: 'pages/src/charts.mjs', host: 'www.w3.org', why: 'an SVG namespace string, never fetched' },
  {
    file: 'pages/mods.html',
    host: 'github.com',
    why: 'example text of the GitHub link field, never fetched by the page',
  },
  {
    file: 'pages/src/nearby.mjs',
    host: 'www.zwift.com',
    why: 'a link a person clicks',
  },
  {
    file: 'pages/src/nearby.mjs',
    host: 'zwiftpower.com',
    why: 'a link a person clicks',
  },
  {
    file: 'pages/src/overview.mjs',
    host: 'www.sauce.llc',
    why: 'inside settingsMain, which the vendored pages never call because the settings page is not shipped; our page policy would block it anyway',
  },
  { file: 'shared/curves.mjs', host: 'gist.github.com', why: 'a link inside a comment' },
  { file: 'shared/sauce/geo.mjs', host: 'www.strava.com', why: 'a link inside a comment' },
  {
    file: 'pages/css/themes.css',
    host: 'www.w3.org',
    why: 'the XML namespace of the inline SVG textures: an identifier, never fetched',
  },
  { file: 'shared/sauce/perf.mjs', host: 'fellrnr.com', why: 'a comment citing a source' },
  { file: 'shared/sauce/perf.mjs', host: 'journals.physiology.org', why: 'a comment citing a source' },
  { file: 'shared/sauce/perf.mjs', host: 'www.timetriallingforum.co.uk', why: 'a comment citing a source' },
  { file: 'shared/sauce/perf.mjs', host: 'www.trainerroad.com', why: 'a comment citing a source' },
  { file: 'shared/sauce/power.mjs', host: 'doi.org', why: 'a comment citing a source' },
  { file: 'shared/sauce/power.mjs', host: 'markliversedge.blogspot.nl', why: 'a comment citing a source' },
  { file: 'shared/sauce/power.mjs', host: 'perfprostudio.com', why: 'a comment citing a source' },
  { file: 'shared/sauce/power.mjs', host: 'www.strava.com', why: 'a comment citing a source' },
  {
    file: 'shared/sauce/time.mjs',
    host: 'time.sauce-llc.workers.dev',
    why: "Sauce's time server, unreachable after the Zluggish patch",
  },
];

/** Text files under `pages/` and `shared/`, as paths relative to the vendored root. */
function textFiles(directory: string, into: Array<string>) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      textFiles(path, into);
    } else if (['.mjs', '.js', '.html', '.css', '.json', '.tpl'].some((extension) => entry.name.endsWith(extension))) {
      into.push(path);
    }
  }

  return into;
}

const hostOf = (url: string) =>
  url.match(/\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)?.map((m) => m.split('//', 2)[1]!) ?? [];

await test('no vendored page or shared module reaches out to a host we did not review', { timeout: 60_000 }, () => {
  const root = resolve(packageRoot(), '../assets/sauce');
  const files = [...textFiles(resolve(root, 'pages'), []), ...textFiles(resolve(root, 'shared'), [])].filter(
    // The chart library is a third-party bundle; its hosts are asserted separately below.
    (file) => relative(root, file) !== join('pages', 'deps', 'src', 'echarts.mjs'),
  );
  const found = new Set<string>();

  for (const file of files) {
    const path = relative(root, file);

    for (const host of hostOf(readFileSync(file, 'utf8'))) {
      found.add(`${path}|${host}`);
    }
  }

  const reviewedSet = new Set(reviewed.map((entry) => `${entry.file}|${entry.host}`));

  for (const pair of found) {
    const [path = '', host = ''] = pair.split('|', 2);

    assert.ok(
      reviewedSet.has(pair),
      `new outside host ${host} in ${path}: review it (comment, link a user clicks, or test mode) before adding it to the list`,
    );
  }

  for (const entry of reviewed) {
    assert.ok(
      found.has(`${entry.file}|${entry.host}`),
      `reviewed entry ${entry.file}|${entry.host} (${entry.why}) no longer occurs: drop it from the list`,
    );
  }
});

await test('the HTML of `/pages` is served byte for byte as the file on disk', { timeout: 60_000 }, async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  const page = await auth(web, '/pages/nearby.html');

  assert.equal(page.status, 200);
  assert.equal(
    await page.text(),
    readFileSync(resolve(packageRoot(), '../assets/sauce/pages/nearby.html'), 'utf8'),
    'no injection may happen without enabled content',
  );
});

await test(
  'the vendored chart bundle only names its licence and namespace hosts, and the time patch stays ahead of the WebSocket',
  { timeout: 60_000 },
  () => {
    const root = resolve(packageRoot(), '../assets/sauce');
    const hosts = new Set(hostOf(readFileSync(resolve(root, 'pages/deps/src/echarts.mjs'), 'utf8')));

    assert.deepEqual(hosts, new Set(['www.w3.org', 'github.com', 'www.apache.org']));

    // The Zluggish patch returns before Sauce's own code runs, so the time server is never contacted;
    // if an update ever moves the WebSocket above the `return`, this comparison catches it.
    const time = readFileSync(resolve(root, 'shared/sauce/time.mjs'), 'utf8');
    const patched = time.indexOf('_timeOfft = 0;');
    const returned = time.indexOf('return;', patched);
    const socket = time.indexOf('new WebSocket(');

    assert.ok(patched !== -1, 'the Zluggish patch of establish() (`_timeOfft = 0;`) is missing');
    assert.ok(socket !== -1, "Sauce's own `new WebSocket(` to the time server must still be present");
    assert.ok(
      patched < returned && returned < socket,
      'the Zluggish patch (`_timeOfft = 0;` then `return;`) must stay before the time-server WebSocket',
    );
  },
);

/**
The per-rider overlay opt-in (`world/overlay-optin.ts`) and the `/pages/*` guard: a signed-in rider
who did not opt in gets a 302 (no-store) to `/overlay`, the web app's own Overlay page, while an
opted-in rider is served the document. The anonymous redirect to `/` stays first, and one rider's
opt-in never reaches another.
*/
await test(
  'a signed-in rider without the overlay opt-in is redirected to /overlay, an opted-in rider is served',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const sessions = f.effects.runSync(WebSessionsService);
    const { id } = f.effects.runSync(sessions.create(f.accounts.identityOf(f.rider)));
    const cookie = `zluggish_web_session=${id}`;

    const off = await get(web, '/pages/chat.html', { redirect: 'manual', headers: { Cookie: cookie } });

    assert.equal(off.status, 302);
    assert.equal(off.headers.get('location'), '/overlay');
    assert.match(off.headers.get('cache-control') ?? '', /no-store/);

    // The very same rider is served once its opt-in is in the file store: the app reads the file
    // lazily once, so the opt-in goes in before a fresh app is built (a running server turns it on
    // through its own instance, i.e. the PUT route below).
    new OverlayOptIn(f.config.storageDir).set(f.rider.player_id, true);

    const opted = createWebApp(f);

    const on = await get(opted, '/pages/chat.html', { headers: { Cookie: cookie } });

    assert.equal(on.status, 200);
    assert.match(on.headers.get('content-type') ?? '', /text\/html/);

    // A missing page of an opted-out signed-in rider still gets /overlay: the guard runs before the
    // file is looked at, exactly like the anonymous redirect to `/`.
    const { id: otherId } = f.effects.runSync(sessions.create(f.accounts.identityOf(f.other)));
    const absent = await get(opted, '/pages/nie-ma.html', {
      redirect: 'manual',
      headers: { Cookie: `zluggish_web_session=${otherId}` },
    });

    assert.equal(absent.status, 302);
    assert.equal(absent.headers.get('location'), '/overlay');

    // Assets stay anonymous whatever the opt-in.
    const served = await get(opted, '/pages/src/common.mjs');

    assert.equal(served.status, 200, 'assets stay anonymous whatever the opt-in');
  },
);

await test(
  'the overlay opt-in API and the /pages guard share one store: the PUT round trip serves the pages',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);
    const web = createWebApp(f);
    const sessions = f.effects.runSync(WebSessionsService);
    const { id, session } = f.effects.runSync(sessions.create(f.accounts.identityOf(f.rider)));
    const headers = {
      Cookie: `zluggish_web_session=${id}`,
      Origin: origin,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json',
    };

    const off = await web.request(`${origin}/api/me/overlay`, { headers });

    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { enabled: false });

    const page = await get(web, '/pages/chat.html', {
      redirect: 'manual',
      headers: { Cookie: `zluggish_web_session=${id}` },
    });

    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/overlay');

    const put = await web.request(`${origin}/api/me/overlay`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: true }),
    });

    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { enabled: true });

    const served = await get(web, '/pages/chat.html', {
      redirect: 'manual',
      headers: { Cookie: `zluggish_web_session=${id}` },
    });

    assert.equal(served.status, 200);

    // An anonymous PUT is refused (the `/api/*` middleware demands a session for the mutating call).
    const anonymous = await web.request(`${origin}/api/me/overlay`, {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    assert.ok(anonymous.status === 401 || anonymous.status === 403, `anonymous PUT: ${anonymous.status}`);
  },
);
