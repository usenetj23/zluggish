import type { Schema } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWebApp } from '#src/http/web-app';
import { mediumFixture } from '#tests/medium/support';
import { OverlayOptIn } from '#src/world/overlay-optin';
import { WebSessionsService } from '#src/services/web-session.service';
import { ManagementService } from '#src/services/management.service';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { ModRegistry } from '#src/world/mods-registry';

/**
Mod web content over HTTP (`src/http/routes/mods.ts`): files of an enabled mod under its declared
`web_root` are served at `/mods/<id>/<web_root>/<file>`, with the page policy (never `unsafe-eval`)
for HTML documents and the session rule of the Sauce pages (302 to `/` for anonymous HTML, 401 for
anonymous assets). The registry rescans the folder on every request, so a second `ModRegistry` on
the same directory shares `<root>/state.json` with the app's own one.
*/

const origin = 'http://local:8080';

const get = (app: ReturnType<typeof createWebApp>, path: string, init: RequestInit = {}) =>
  app.request(`${origin}${path}`, init);

/** A signed-in web session of the fixture's rider: a `get` carrying its session cookie. */
function signedIn(f: Awaited<ReturnType<typeof mediumFixture>>) {
  // The ordinary Sauce page checked below is an HTML document of `/pages/*` and is only served to a
  // rider who opted into the Overlay (see `world/overlay-optin`).
  new OverlayOptIn(f.config.storageDir).set(f.rider.player_id, true);
  const sessions = f.effects.runSync(WebSessionsService);
  const { id } = f.effects.runSync(sessions.create(f.accounts.identityOf(f.rider)));
  const cookie = `zluggish_web_session=${id}`;

  const get = (app: ReturnType<typeof createWebApp>, path: string, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, {
      ...init,
      headers: new Headers([...new Headers(init.headers), ['Cookie', cookie]]),
    });

  return { cookie, get };
}

/** Creates `<storageDir>/mods/<id>/manifest.json` plus `pages/<id>.html` and `pages/src/a.mjs`. */
function makeMod(storageDir: string, id: string): void {
  const dir = join(storageDir, 'mods', id);

  mkdirSync(join(dir, 'pages', 'src'), { recursive: true });

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 1,
      id,
      name: id === 'hill-radar' ? 'Hill Radar' : id,
      description: 'd',
      version: '1',
      web_root: 'pages',
      windows: [{ file: `pages/${id}.html`, id, name: id === 'hill-radar' ? 'Hill Radar' : id }],
    }),
  );

  writeFileSync(join(dir, 'pages', `${id}.html`), '<!doctype html><title>x</title>');
  writeFileSync(join(dir, 'pages', 'src', 'a.mjs'), 'export const a = 1;');
}

const enable = (storageDir: string, id: string): void => {
  const registry = new ModRegistry(join(storageDir, 'mods'));

  void registry.setEnabled(id, true, registry.get(id)?.hash ?? '');
};

await test(
  'an enabled mod page is served to a signed-in rider with the page policy and nosniff',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);
    makeMod(f.config.storageDir, 'hill-radar');
    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const page = await auth(web, '/mods/hill-radar/pages/hill-radar.html');

    const pageType = page.headers.get('content-type') ?? '';

    assert.equal(page.status, 200);
    assert.ok(pageType.includes('text/html'), pageType);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    const csp = page.headers.get('content-security-policy') ?? '';
    const scriptSrc = /script-src[^;]*/.exec(csp)?.[0] ?? '';

    assert.ok(csp.includes("script-src 'self';"), csp);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src must not allow eval: ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src must not allow inline: ${scriptSrc}`);

    const module = await auth(web, '/mods/hill-radar/pages/src/a.mjs');

    assert.equal(module.status, 200);
    const moduleType = module.headers.get('content-type') ?? '';

    assert.ok(moduleType.includes('text/javascript'), moduleType);
    assert.equal(await module.text(), 'export const a = 1;');
  },
);

await test(
  'a mod that is not enabled, outside its web root or outside the folder is not served',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);
    makeMod(f.config.storageDir, 'hill-radar');
    makeMod(f.config.storageDir, 'off');
    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const rejected = [
      '/mods/off/pages/x.html',
      '/mods/hill-radar/manifest.json',
      '/mods/hill-radar/pages/..%2fmanifest.json',
      '/mods/hill-radar/pages/%2e%2e/manifest.json',
      '/mods/hill-radar/pages/missing.html',
      '/mods/nope/pages/a.html',
      '/mods/hill-radar/pages/a%5Cb.html',
    ];

    for (const path of rejected) {
      const response = await auth(web, path);

      assert.equal(response.status, 404, `${path} must not be served`);
    }
  },
);

await test(
  'changing a file of an enabled mod switches it off until it is approved again',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);
    makeMod(f.config.storageDir, 'hill-radar');
    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const before = await auth(web, '/mods/hill-radar/pages/hill-radar.html');

    assert.equal(before.status, 200);

    writeFileSync(
      join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'hill-radar.html'),
      '<!doctype html><title>changed</title>',
    );

    const changed = await auth(web, '/mods/hill-radar/pages/hill-radar.html');

    assert.equal(changed.status, 404, 'a changed mod must go off until it is approved again');

    enable(f.config.storageDir, 'hill-radar');

    const again = await auth(web, '/mods/hill-radar/pages/hill-radar.html');

    assert.equal(again.status, 200);
    assert.equal(await again.text(), '<!doctype html><title>changed</title>');
  },
);

await test('mod content needs a session', { timeout: 30_000 }, async (t) => {
  const f = await mediumFixture(t);
  makeMod(f.config.storageDir, 'hill-radar');
  enable(f.config.storageDir, 'hill-radar');

  const web = createWebApp(f);

  const page = await get(web, '/mods/hill-radar/pages/hill-radar.html', { redirect: 'manual' });

  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/');

  const module = await get(web, '/mods/hill-radar/pages/src/a.mjs', { redirect: 'manual' });

  assert.equal(module.status, 401);
});

/** The CSP base64 digest of an inline script body, as `inlineScriptHashes` computes it. */
const digest = (text: string): string => Buffer.from(new CryptoRepository().sha256(text), 'hex').toString('base64');

await test(
  'a mod page with inline scripts is served with the digests of exactly those scripts',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeMod(f.config.storageDir, 'hill-radar');

    // The page must exist BEFORE the mod is enabled: the registry pins the content hashes.
    const first = 'const one = 1;';
    const second = 'const two = 2;';

    writeFileSync(
      join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'inline.html'),
      `<!doctype html><title>inline</title><script type="module">${first}</script>` +
        `<script type="module">${second}</script><script src="./x.mjs"></script>`,
    );

    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const page = await auth(web, '/mods/hill-radar/pages/inline.html');
    const csp = page.headers.get('content-security-policy') ?? '';
    const scriptSrc = /script-src[^;]*/.exec(csp)?.[0] ?? '';

    assert.equal(page.status, 200);
    assert.equal(scriptSrc, `script-src 'self' 'sha256-${digest(first)}' 'sha256-${digest(second)}'`, csp);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src must not allow inline: ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src must not allow eval: ${scriptSrc}`);
  },
);

await test(
  'a CRLF mod page is hashed and served with LF line ends, as a browser digests it',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeMod(f.config.storageDir, 'hill-radar');

    writeFileSync(
      join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'crlf.html'),
      '<!doctype html>\r\n<title>crlf</title>\r\n<script>\r\nconst one = 1;\r\nconst two = 2;\r\n</script>\r\n',
    );

    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const page = await auth(web, '/mods/hill-radar/pages/crlf.html');
    const csp = page.headers.get('content-security-policy') ?? '';
    const body = await page.text();

    assert.equal(page.status, 200);
    assert.ok(!body.includes('\r'), 'the served page still has carriage returns');
    assert.ok(csp.includes(`'sha256-${digest('\nconst one = 1;\nconst two = 2;\n')}'`), csp);
  },
);

await test('a mod page without inline scripts keeps exactly script-src self', { timeout: 30_000 }, async (t) => {
  const f = await mediumFixture(t);

  makeMod(f.config.storageDir, 'hill-radar');
  enable(f.config.storageDir, 'hill-radar');

  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  const page = await auth(web, '/mods/hill-radar/pages/hill-radar.html');
  const csp = page.headers.get('content-security-policy') ?? '';

  assert.equal(page.status, 200);
  assert.ok(csp.includes("script-src 'self';"), csp);
  assert.ok(!/script-src[^;]*sha256-/.test(csp), csp);
  assert.ok(!csp.includes('script-src-attr'), `no handlers means no script-src-attr: ${csp}`);
});

await test(
  'a mod page with inline event handlers is served with script-src-attr unsafe-hashes digests',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeMod(f.config.storageDir, 'hill-radar');

    // The page must exist BEFORE the mod is enabled: the registry pins the content hashes.
    writeFileSync(
      join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'handlers.html'),
      '<!doctype html><title>handlers</title><button onclick="go()">go</button><input oninput="f(this.value)">',
    );

    enable(f.config.storageDir, 'hill-radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const page = await auth(web, '/mods/hill-radar/pages/handlers.html');
    const csp = page.headers.get('content-security-policy') ?? '';
    const scriptSrcAttr = /script-src-attr[^;]*/.exec(csp)?.[0] ?? '';

    const scriptSrc = /(?<!-)script-src [^;]*/.exec(csp)?.[0] ?? '';

    assert.equal(page.status, 200);
    assert.ok(scriptSrcAttr.includes("script-src-attr 'unsafe-hashes'"), csp);
    assert.ok(scriptSrcAttr.includes(`'sha256-${digest('go()')}'`), csp);
    assert.ok(scriptSrcAttr.includes(`'sha256-${digest('f(this.value)')}'`), csp);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src must not allow inline: ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src must not allow eval: ${scriptSrc}`);
    assert.ok(!scriptSrcAttr.includes("'unsafe-inline'"), `script-src-attr must not allow inline: ${scriptSrcAttr}`);
    assert.ok(!scriptSrcAttr.includes("'unsafe-eval'"), `script-src-attr must not allow eval: ${scriptSrcAttr}`);
  },
);

await test('a mod page with too many inline handlers is not served', { timeout: 30_000 }, async (t) => {
  const f = await mediumFixture(t);

  makeMod(f.config.storageDir, 'hill-radar');

  // The page must exist BEFORE the mod is enabled: the registry pins the content hashes.
  const handlers = Array.from({ length: 201 }, (_, index) => `<button onclick="g${index}()">x</button>`);

  writeFileSync(
    join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'many-handlers.html'),
    `<!doctype html><title>many handlers</title>${handlers.join('')}`,
  );

  enable(f.config.storageDir, 'hill-radar');

  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  const page = await auth(web, '/mods/hill-radar/pages/many-handlers.html');

  assert.equal(page.status, 422);
  assert.equal(await page.text(), 'This mod page cannot be served.');
});

await test('a mod page with too many inline scripts is not served', { timeout: 30_000 }, async (t) => {
  const f = await mediumFixture(t);

  makeMod(f.config.storageDir, 'hill-radar');

  // The page must exist BEFORE the mod is enabled: the registry pins the content hashes.
  const scripts = Array.from(
    { length: 21 },
    (_, index) => `<script type="module">const v${index} = ${index};</script>`,
  );

  writeFileSync(
    join(f.config.storageDir, 'mods', 'hill-radar', 'pages', 'many.html'),
    `<!doctype html><title>many</title>${scripts.join('')}`,
  );

  enable(f.config.storageDir, 'hill-radar');

  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  const page = await auth(web, '/mods/hill-radar/pages/many.html');

  assert.equal(page.status, 422);
  assert.equal(await page.text(), 'This mod page cannot be served.');
});

await test('an ordinary Sauce page keeps the unchanged page policy', { timeout: 30_000 }, async (t) => {
  const f = await mediumFixture(t);

  const web = createWebApp(f);
  const { get: auth } = signedIn(f);

  const page = await auth(web, '/pages/nearby.html');
  const csp = page.headers.get('content-security-policy') ?? '';

  assert.equal(page.status, 200);
  assert.ok(csp.includes("script-src 'self';"), csp);
  assert.ok(!/script-src[^;]*(unsafe-(inline|eval)|sha256-)/.test(csp), csp);
});

/** Creates `<storageDir>/mods/<id>/manifest.json` from `manifest` plus `files` (relative -> body). */
function makeContentMod(
  storageDir: string,
  id: string,
  manifest: Readonly<Record<string, typeof Schema.Json.Type>>,
  files: Record<string, string>,
): void {
  const dir = join(storageDir, 'mods', id);

  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, path), body);
  }

  // The files must exist BEFORE the mod is enabled: the registry pins the content hashes.
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ manifest_version: 1, id, name: id, description: 'd', version: '1', ...manifest }),
  );
}

await test(
  "a mod's declared content file is served even in a subfolder, and is injected into another mod's page before </head>",
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeContentMod(
      f.config.storageDir,
      'zen',
      { web_root: 'pages', content_js: ['pages/src/data-fields.js'] },
      {
        'pages/src/data-fields.js': 'window.zen = 1;',
      },
    );
    makeContentMod(
      f.config.storageDir,
      'radar',
      { web_root: 'pages', windows: [{ file: 'pages/radar.html', id: 'radar', name: 'radar' }] },
      {
        'pages/radar.html': '<!doctype html><html><head><title>radar</title></head><body></body></html>',
      },
    );

    enable(f.config.storageDir, 'zen');
    enable(f.config.storageDir, 'radar');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const script = await auth(web, '/mods/zen/pages/src/data-fields.js');

    assert.equal(script.status, 200);
    assert.equal(await script.text(), 'window.zen = 1;');

    const page = await auth(web, '/mods/radar/pages/radar.html');
    const body = await page.text();

    assert.equal(page.status, 200);

    const tag = '<script src="/mods/zen/pages/src/data-fields.js"></script>';
    const injected = body.split(tag).length - 1;

    assert.equal(injected, 1, `the tag must appear exactly once: ${body}`);
    assert.ok(body.indexOf(tag) < body.indexOf('</head>'), `the tag must come before </head>: ${body}`);
  },
);

await test(
  'a declared content file outside the web root is served, an undeclared sibling of it is not',
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeContentMod(
      f.config.storageDir,
      'wide',
      { web_root: 'pages', content_css: ['theme/dark.css'] },
      {
        'pages/wide.html': '<!doctype html><html><head><title>wide</title></head></html>',
        'theme/dark.css': 'body { background: black; }',
        'theme/other.css': 'body { background: white; }',
      },
    );

    enable(f.config.storageDir, 'wide');

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const css = await auth(web, '/mods/wide/theme/dark.css');
    const cssType = css.headers.get('content-type') ?? '';

    assert.equal(css.status, 200);
    assert.ok(cssType.includes('text/css'), cssType);
    assert.equal(await css.text(), 'body { background: black; }');

    for (const path of ['/mods/wide/theme/other.css', '/mods/wide/manifest.json']) {
      const response = await auth(web, path);

      assert.equal(response.status, 404, `${path} must not be served`);
    }
  },
);

await test(
  "a disabled mod's content is neither served nor injected into another mod's page",
  { timeout: 30_000 },
  async (t) => {
    const f = await mediumFixture(t);

    makeContentMod(
      f.config.storageDir,
      'zen',
      { web_root: 'pages', content_js: ['pages/src/data-fields.js'] },
      {
        'pages/src/data-fields.js': 'window.zen = 1;',
      },
    );
    makeContentMod(
      f.config.storageDir,
      'ghost',
      { web_root: 'pages', content_js: ['pages/src/ghost.js'] },
      {
        'pages/src/ghost.js': 'window.ghost = 1;',
      },
    );
    makeContentMod(
      f.config.storageDir,
      'radar',
      { web_root: 'pages', windows: [{ file: 'pages/radar.html', id: 'radar', name: 'radar' }] },
      {
        'pages/radar.html': '<!doctype html><html><head><title>radar</title></head><body></body></html>',
      },
    );

    enable(f.config.storageDir, 'zen');
    enable(f.config.storageDir, 'radar');
    // 'ghost' is created but never enabled.

    const web = createWebApp(f);
    const { get: auth } = signedIn(f);

    const served = await auth(web, '/mods/ghost/pages/src/ghost.js');

    assert.equal(served.status, 404, "a disabled mod's content file must not be served");

    const page = await auth(web, '/mods/radar/pages/radar.html');
    const body = await page.text();

    assert.equal(page.status, 200);
    assert.ok(body.includes('<script src="/mods/zen/pages/src/data-fields.js"></script>'), body);
    assert.ok(!body.includes('ghost.js'), `a disabled mod must not be injected: ${body}`);
  },
);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }

  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff;

  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }

  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** A stored-entry zip: local file headers, the central directory and the end record. */
function storedZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let localSize = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    locals.push(local, nameBytes, file.data);
    localSize += local.length + nameBytes.length + file.data.length;

    const entry = Buffer.alloc(46);

    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // method: stored
    entry.writeUInt16LE(0, 12); // time
    entry.writeUInt16LE(0, 14); // date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(file.data.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(localSize - local.length - nameBytes.length - file.data.length, 42);

    central.push(entry, nameBytes);
    centralSize += entry.length + nameBytes.length;
  }

  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, ...central, eocd]);
}

await test(
  'installModFromZip accepts an archive well above the 64 KiB body limit of the other calls',
  { timeout: 60_000 },
  async (t) => {
    const f = await mediumFixture(t);

    // The RPC demands an administrator session: the setup claim of the web app promotes the claimed
    // user, exactly like the first run of a fresh install.
    const management = f.effects.runSync(ManagementService);

    await f.effects.runPromise(
      management.setup({
        mode: 'existing',
        key: f.effects.runSync(management.issueSetupKey())!,
        username: f.rider.username,
        password: 'test-password',
      }),
    );

    const sessions = f.effects.runSync(WebSessionsService);
    const { id, session } = f.effects.runSync(
      sessions.create(f.accounts.identityOf(f.accounts.get(f.rider.player_id)!)),
    );

    const web = createWebApp(f);

    const post = (name: string, body: string) =>
      web.request(`${origin}/api/rpc/v1/${name}`, {
        method: 'POST',
        headers: {
          Cookie: `zluggish_web_session=${id}`,
          Origin: origin,
          'X-CSRF-Token': session.csrf,
          'Content-Type': 'application/json',
        },
        body,
      });

    // 1.5 MB of random bytes: incompressible, so the base64 body is about 2 MB.
    const archive = storedZip([
      {
        name: 'my-big-mod/manifest.json',
        data: Buffer.from(
          JSON.stringify({
            manifest_version: 1,
            id: 'big-mod',
            name: 'Big Mod',
            description: 'd',
            version: '1.0.0',
            web_root: 'pages',
          }),
          'utf8',
        ),
      },
      { name: 'my-big-mod/pages/blob.bin', data: randomBytes(1_500_000) },
    ]);

    const installed = await post('installModFromZip', JSON.stringify([archive.toString('base64')]));

    assert.notEqual(installed.status, 413, 'the zip RPC gets a roomier body limit than the other calls');
    assert.equal(installed.status, 200);

    const answer = await installed.json();

    assert.equal(answer.success, true);
    assert.equal(answer.value.id, 'big-mod');
    assert.equal(answer.value.source, 'zip');

    // Every other RPC name still gets the 64 KiB body limit of the app.
    const oversized = await post('getAthleteData', JSON.stringify(['x'.repeat(70 * 1024)]));

    assert.equal(oversized.status, 413);
  },
);
