import { ModStore, githubRepoOf, parseGitHubInput } from '#src/world/mod-store';
import type { StoreMod, FetchLike } from '#src/world/mod-store';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const crypto = new CryptoRepository();

const DIRECTORY_URL = 'https://raw.githubusercontent.com/SauceLLC/sauce4zwift-mod-store/main/directory.json';
const DIR_ALIAS_URL = 'https://mod-api.sauce.llc/store/directory.json';
const ALPHA_ZIP_URL = 'https://raw.githubusercontent.com/SauceLLC/alpha-mod/releases/alpha-1.0.0.zip';
const BETA_OLD_ZIP_URL = 'https://mod-api.sauce.llc/releases/beta-1.0.0.zip';
const BETA_NEW_ZIP_URL = 'https://github.com/SauceLLC/beta-mod/releases/download/v1.1.0/beta-1.1.0.zip';
const EVIL_URL = 'https://evil.example/x.zip';

const ALPHA_BYTES = Buffer.from('alpha archive payload');
const BETA_OLD_BYTES = Buffer.from('beta one archive payload');
const BETA_NEW_BYTES = Buffer.from('beta two archive payload which is longer');

const directoryJson = (value: unknown): string => JSON.stringify(value);

const goodDirectory = () => [
  {
    id: 'alpha-mod',
    name: 'Alpha Mod',
    description: 'first mod',
    tags: ['fun'],
    homeURL: 'https://github.com/SauceLLC/alpha-mod',
    logoURL: 'https://raw.githubusercontent.com/SauceLLC/alpha-mod/logo.png',
    releases: [
      {
        version: '1.0.0',
        url: ALPHA_ZIP_URL,
        hash: crypto.sha256(ALPHA_BYTES),
        size: ALPHA_BYTES.length,
        minVersion: '1.0.0',
        updated: 1500,
        notes: 'alpha notes',
      },
    ],
  },
  {
    id: 'beta-mod',
    name: 'Beta Mod',
    description: 'second mod',
    tags: ['utility', 'quality-of-life'],
    homeURL: null,
    logoURL: null,
    releases: [
      {
        version: '1.0.0',
        url: BETA_OLD_ZIP_URL,
        hash: crypto.sha256(BETA_OLD_BYTES),
        size: BETA_OLD_BYTES.length,
        minVersion: null,
        updated: 1000,
        notes: null,
      },
      {
        version: '1.1.0',
        url: BETA_NEW_ZIP_URL,
        hash: crypto.sha256(BETA_NEW_BYTES),
        size: BETA_NEW_BYTES.length,
        minVersion: '2.0.0',
        updated: 2000,
        notes: 'newer release',
      },
    ],
  },
];

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

interface CapturedInit {
  redirect: string;
  headers: Record<string, string>;
}

interface FakeFetch {
  calls: number;
  urls: Array<string>;
  inits: Array<CapturedInit>;
  fetch: FetchLike;
}

const fakeFetch = (handler: (url: string) => FakeReply): FakeFetch => {
  const state: FakeFetch = {
    calls: 0,
    urls: [],
    inits: [],
    fetch: (url, init): Promise<Response> => {
      state.calls += 1;
      state.urls.push(url);
      state.inits.push({ redirect: init.redirect, headers: init.headers });

      const reply = handler(url);
      const headers = { ...reply.headers, 'content-type': 'application/octet-stream' };
      const body: BlobPart | undefined =
        reply.body === undefined
          ? undefined
          : typeof reply.body === 'string'
            ? reply.body
            : Uint8Array.from(reply.body);

      return Promise.resolve(new Response(body ?? null, { status: reply.status ?? 200, headers }));
    },
  };
  return state;
};

const serve = (routes: Record<string, FakeReply>): FakeFetch => fakeFetch((url) => routes[url] ?? { status: 404 });

const goodRoutes = () => ({
  [DIRECTORY_URL]: { body: directoryJson(goodDirectory()) },
  [ALPHA_ZIP_URL]: { body: ALPHA_BYTES },
  [BETA_OLD_ZIP_URL]: { body: BETA_OLD_BYTES },
  [BETA_NEW_ZIP_URL]: { body: BETA_NEW_BYTES },
});

await test('directory parses two mods, sorts by name and caches within cacheMs', async () => {
  let clock = 0;
  const fake = serve(goodRoutes());
  const store = new ModStore({ fetch: fake.fetch, now: () => clock, cacheMs: 1000 });

  const mods = await store.directory();
  assert.equal(fake.calls, 1);
  assert.deepEqual(
    mods.map((mod) => mod.id),
    ['alpha-mod', 'beta-mod'],
  );

  const beta = mods[1];
  assert.ok(beta);
  assert.equal(beta.name, 'Beta Mod');
  assert.deepEqual(beta.tags, ['utility', 'quality-of-life']);
  assert.equal(beta.homeURL, null);
  assert.equal(beta.logoURL, null);
  assert.equal(beta.releases.length, 2);
  assert.equal(beta.releases[0]?.version, '1.1.0');
  assert.equal(beta.releases[0]?.updated, 2000);
  assert.equal(beta.releases[0]?.minVersion, '2.0.0');
  assert.equal(beta.releases[0]?.notes, 'newer release');
  assert.equal(beta.releases[1]?.version, '1.0.0');
  assert.equal(beta.releases[1]?.minVersion, null);
  assert.equal(beta.releases[1]?.notes, null);

  const alpha = mods[0];
  assert.ok(alpha);
  assert.equal(alpha.description, 'first mod');
  assert.equal(alpha.homeURL, 'https://github.com/SauceLLC/alpha-mod');
  assert.equal(alpha.logoURL, 'https://raw.githubusercontent.com/SauceLLC/alpha-mod/logo.png');

  clock = 999;
  const cached = await store.directory();
  assert.equal(fake.calls, 1);
  assert.deepEqual(
    cached.map((mod) => mod.id),
    ['alpha-mod', 'beta-mod'],
  );

  clock = 1000;
  await store.directory();
  assert.equal(fake.calls, 2);
});

await test('directory trims surrounding whitespace in text fields', async () => {
  const padded = goodDirectory();
  const beta = padded[1];
  assert.ok(beta);
  beta['id'] = '  beta-mod  ';
  beta['name'] = '  Beta Mod  ';
  beta['description'] = '  second mod  ';

  const routes = goodRoutes();
  routes[DIRECTORY_URL] = { body: directoryJson(padded) };
  const fake = serve(routes);
  const store = new ModStore({ fetch: fake.fetch });

  const mods = await store.directory();
  assert.equal(mods.length, 2);
  assert.deepEqual(
    mods.map((mod) => mod.name),
    ['Alpha Mod', 'Beta Mod'],
  );
  assert.deepEqual(
    mods.map((mod) => mod.id),
    ['alpha-mod', 'beta-mod'],
  );
  assert.equal(mods[1]?.description, 'second mod');
});

await test('directory drops bad entries and mods left without a valid release', async () => {
  const entries: Array<unknown> = [
    {
      name: 'No Id',
      releases: [{ version: '1.0.0', url: ALPHA_ZIP_URL, hash: crypto.sha256(ALPHA_BYTES), size: ALPHA_BYTES.length }],
    },
    {
      id: 'bad-hash',
      name: 'Bad Hash',
      releases: [{ version: '1.0.0', url: ALPHA_ZIP_URL, hash: 'not-hex', size: ALPHA_BYTES.length }],
    },

    {
      id: 'plain-http',
      name: 'Plain Http',
      releases: [
        {
          version: '1.0.0',
          // eslint-disable-next-line unicorn/prefer-https -- a deliberately rejected plain-http release url
          url: 'http://raw.githubusercontent.com/x.zip',
          hash: crypto.sha256(ALPHA_BYTES),
          size: ALPHA_BYTES.length,
        },
      ],
    },
    {
      id: 'evil-host',
      name: 'Evil Host',
      releases: [{ version: '1.0.0', url: EVIL_URL, hash: crypto.sha256(ALPHA_BYTES), size: ALPHA_BYTES.length }],
    },
    {
      id: 'too-large',
      name: 'Too Large',
      releases: [{ version: '1.0.0', url: ALPHA_ZIP_URL, hash: crypto.sha256(ALPHA_BYTES), size: 60_000_000 }],
    },
    { id: 'no-releases', name: 'No Releases', releases: [] },
    {
      id: 'mixed',
      name: 'Mixed Mod',
      description: 'one bad release and one good one',
      tags: ['mixed', 7],
      releases: [
        { version: '1.0.0', url: EVIL_URL, hash: 'zz', size: 10 },
        {
          version: '1.2.0',
          url: BETA_NEW_ZIP_URL,
          hash: crypto.sha256(BETA_NEW_BYTES),
          size: BETA_NEW_BYTES.length,
          updated: 5,
        },
      ],
    },
  ];

  const fake = serve({
    [DIRECTORY_URL]: { body: directoryJson(entries) },
    [BETA_NEW_ZIP_URL]: { body: BETA_NEW_BYTES },
  });
  const store = new ModStore({ fetch: fake.fetch });

  const mods = await store.directory();
  assert.equal(mods.length, 1);
  assert.equal(mods[0]?.id, 'mixed');
  assert.deepEqual(
    mods[0]?.releases.map((release) => release.version),
    ['1.2.0'],
  );
  assert.deepEqual(mods[0]?.tags, ['mixed']);
});

await test('directory rejects a non-array body and an HTTP 500', async () => {
  const nonArray = serve({ [DIRECTORY_URL]: { body: directoryJson({ mods: [] }) } });
  const nonArrayStore = new ModStore({ fetch: nonArray.fetch });
  await assert.rejects(nonArrayStore.directory(), /unexpected store directory/);

  const failing = serve({ [DIRECTORY_URL]: { status: 500, body: 'boom' } });
  const failingStore = new ModStore({ fetch: failing.fetch });
  await assert.rejects(failingStore.directory(), /download failed: HTTP 500/);
});

await test('download verifies size and sha256 and honours the requested version', async () => {
  const fake = serve(goodRoutes());
  const store = new ModStore({ fetch: fake.fetch });

  const newest = await store.download('beta-mod');
  assert.equal(newest.release.version, '1.1.0');
  assert.equal(newest.mod.name, 'Beta Mod');
  assert.deepEqual(newest.archive, BETA_NEW_BYTES);

  const older = await store.download('beta-mod', '1.0.0');
  assert.equal(older.release.version, '1.0.0');
  assert.deepEqual(older.archive, BETA_OLD_BYTES);

  await assert.rejects(store.download('nope'), /unknown store mod/);
  await assert.rejects(store.download('beta-mod', '9.9.9'), /unknown release/);
});

await test('download rejects a wrong hash and a wrong length', async () => {
  const tamperedHash = serve({
    [DIRECTORY_URL]: { body: directoryJson(goodDirectory()) },
    [BETA_NEW_ZIP_URL]: {
      body: Buffer.concat([BETA_NEW_BYTES.subarray(0, 8), Buffer.alloc(BETA_NEW_BYTES.length - 8, 0x64)]),
    },
  });
  const hashStore = new ModStore({ fetch: tamperedHash.fetch });
  await assert.rejects(hashStore.download('beta-mod'), /hash mismatch/);

  const tamperedSize = serve({
    [DIRECTORY_URL]: { body: directoryJson(goodDirectory()) },
    [BETA_NEW_ZIP_URL]: { body: BETA_NEW_BYTES.subarray(0, -5) },
  });
  const sizeStore = new ModStore({ fetch: tamperedSize.fetch });
  await assert.rejects(sizeStore.download('beta-mod'), /size mismatch/);
});

await test('download follows an allowed redirect and refuses an evil one', async () => {
  const redirected = serve({
    [DIRECTORY_URL]: { status: 302, headers: { location: DIR_ALIAS_URL } },
    [DIR_ALIAS_URL]: { body: directoryJson(goodDirectory()) },
    [BETA_NEW_ZIP_URL]: { status: 302, headers: { location: BETA_OLD_ZIP_URL } },
    [BETA_OLD_ZIP_URL]: { body: BETA_NEW_BYTES },
  });
  const redirectStore = new ModStore({ fetch: redirected.fetch });

  const result = await redirectStore.download('beta-mod', '1.1.0');
  assert.deepEqual(result.archive, BETA_NEW_BYTES);
  assert.deepEqual(redirected.urls, [DIRECTORY_URL, DIR_ALIAS_URL, BETA_NEW_ZIP_URL, BETA_OLD_ZIP_URL]);

  const evil = serve({
    [DIRECTORY_URL]: { body: directoryJson(goodDirectory()) },
    [BETA_NEW_ZIP_URL]: { status: 302, headers: { location: EVIL_URL } },
  });
  const evilStore = new ModStore({ fetch: evil.fetch });
  await assert.rejects(evilStore.download('beta-mod'), /host not allowed/);
});

await test('download gives up after more than four redirects', async () => {
  let hop = 0;
  const loop = fakeFetch(() => {
    hop += 1;
    return { status: 302, headers: { location: `https://mod-api.sauce.llc/hop/${hop}.json` } };
  });
  const store = new ModStore({ fetch: loop.fetch });

  await assert.rejects(store.directory(), /download failed: HTTP 302/);
  assert.equal(loop.calls, 5);
});

const HILL_RADAR_URL = 'https://codeload.github.com/Aryeh95/s4z-hill-radar/zip/HEAD';

await test('downloadGitHub builds codeload urls for default, branch and tag refs', async () => {
  const archive = Buffer.from('hill radar zip bytes');
  const fake = serve({
    [HILL_RADAR_URL]: { body: archive },
    'https://codeload.github.com/Aryeh95/s4z-hill-radar/zip/refs/heads/main': { body: archive },
    'https://codeload.github.com/Aryeh95/s4z-hill-radar/zip/refs/tags/v0.5.0': { body: archive },
  });
  const store = new ModStore({ fetch: fake.fetch });

  const defaulted = await store.downloadGitHub('Aryeh95/s4z-hill-radar');
  assert.equal(fake.urls.at(-1), HILL_RADAR_URL);
  assert.deepEqual(defaulted, { repo: 'Aryeh95/s4z-hill-radar', ref: 'HEAD', archive });

  const branch = await store.downloadGitHub('Aryeh95/s4z-hill-radar', 'main');
  assert.equal(fake.urls.at(-1), 'https://codeload.github.com/Aryeh95/s4z-hill-radar/zip/refs/heads/main');
  assert.deepEqual(branch, { repo: 'Aryeh95/s4z-hill-radar', ref: 'main', archive });

  const tag = await store.downloadGitHub('Aryeh95/s4z-hill-radar', 'v0.5.0');
  assert.equal(fake.urls.at(-1), 'https://codeload.github.com/Aryeh95/s4z-hill-radar/zip/refs/tags/v0.5.0');
  assert.deepEqual(tag, { repo: 'Aryeh95/s4z-hill-radar', ref: 'v0.5.0', archive });
});

await test('downloadGitHub rejects invalid repositories and refs', async () => {
  const fake = serve({});
  const store = new ModStore({ fetch: fake.fetch });

  for (const repo of ['a', 'a/b/c', '../x/y', 'a/b..c', 'a b/c', '.a/b']) {
    await assert.rejects(store.downloadGitHub(repo), /invalid repository/);
  }
  for (const ref of ['a..b', 'a b', '']) {
    await assert.rejects(store.downloadGitHub('Aryeh95/s4z-hill-radar', ref), /invalid ref/);
  }
  assert.equal(fake.calls, 0);
});

await test('downloadGitHub enforces the size cap and the host allow-list on redirects', async () => {
  const huge = serve({
    [HILL_RADAR_URL]: {
      status: 200,
      headers: { 'content-length': String(60_000_001) },
      body: Buffer.alloc(10),
    },
  });
  const hugeStore = new ModStore({ fetch: huge.fetch, maxArchiveBytes: 50_000_000 });
  await assert.rejects(hugeStore.downloadGitHub('Aryeh95/s4z-hill-radar'), /download too large/);

  const evil = serve({
    [HILL_RADAR_URL]: { status: 302, headers: { location: EVIL_URL } },
  });
  const evilStore = new ModStore({ fetch: evil.fetch });
  await assert.rejects(evilStore.downloadGitHub('Aryeh95/s4z-hill-radar'), /host not allowed/);
});

await test('requests carry the Zluggish User-Agent and manual redirects', async () => {
  const fake = serve(goodRoutes());
  const store = new ModStore({ fetch: fake.fetch });

  await store.directory();
  assert.equal(fake.inits.length, 1);
  assert.equal(fake.inits[0]?.redirect, 'manual');
  assert.ok((fake.inits[0]?.headers['User-Agent'] ?? '').startsWith('ZluggishOverlay'));
});

interface StreamState {
  chunksRead: number;
  cancelled: boolean;
}

interface StreamingFetch {
  state: StreamState;
  fetch: FetchLike;
}

const streamingFetch = (chunks: Array<Buffer>, headers: Record<string, string> = {}): StreamingFetch => {
  const state: StreamState = { chunksRead: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: (controller): void => {
        const chunk = chunks[state.chunksRead];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        state.chunksRead += 1;
        controller.enqueue(Uint8Array.from(chunk));
      },
      cancel: (): void => {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, fetch: (): Promise<Response> => Promise.resolve(new Response(stream, { status: 200, headers })) };
};

await test('downloadGitHub streams chunked bodies and stops at the first chunk past the cap', async () => {
  const chunk = Buffer.alloc(400, 0x61);
  const stream = streamingFetch(Array.from({ length: 20 }, () => chunk));
  const store = new ModStore({ fetch: stream.fetch, maxArchiveBytes: 1000 });

  await assert.rejects(store.downloadGitHub('Aryeh95/s4z-hill-radar'), /download too large/);
  assert.equal(stream.state.chunksRead, 3);
  assert.equal(stream.state.cancelled, true);
});

await test('downloadGitHub accepts a chunked body exactly at the cap', async () => {
  const chunk = Buffer.alloc(400, 0x62);
  const stream = streamingFetch([chunk, chunk, chunk]);
  const store = new ModStore({ fetch: stream.fetch, maxArchiveBytes: 1200 });

  const result = await store.downloadGitHub('Aryeh95/s4z-hill-radar');
  assert.equal(result.archive.length, 1200);
  assert.equal(stream.state.chunksRead, 3);
  assert.equal(stream.state.cancelled, false);
});

await test('downloadGitHub rejects a body larger than a lying small content-length', async () => {
  const chunk = Buffer.alloc(400, 0x63);
  const stream = streamingFetch(
    Array.from({ length: 10 }, () => chunk),
    { 'content-length': '10' },
  );
  const store = new ModStore({ fetch: stream.fetch, maxArchiveBytes: 2000 });

  await assert.rejects(store.downloadGitHub('Aryeh95/s4z-hill-radar'), /download too large/);
  assert.equal(stream.state.chunksRead, 6);
  assert.equal(stream.state.cancelled, true);
});

const rejectingFetch = (error: unknown): FakeFetch => ({
  calls: 0,
  urls: [],
  inits: [],
  fetch: (): Promise<Response> => Promise.reject(error),
});

await test('directory maps a network failure of the fetch to an upstream download error', async () => {
  const store = new ModStore({ fetch: rejectingFetch(new TypeError('fetch failed')).fetch });
  await assert.rejects(store.directory(), (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'download failed: cannot reach raw.githubusercontent.com');
    return true;
  });
});

await test('download maps a network failure of the release fetch to the release host', async () => {
  const failingRelease = fakeFetch((url) => {
    if (url === DIRECTORY_URL) {
      return { body: directoryJson(goodDirectory()) };
    }
    throw new TypeError('fetch failed');
  });
  const store = new ModStore({ fetch: failingRelease.fetch });
  await assert.rejects(store.download('beta-mod', '1.0.0'), /download failed: cannot reach mod-api\.sauce\.llc/);
});

await test('directory maps an abort or timeout to the timeout error', async () => {
  const aborted = new ModStore({
    fetch: rejectingFetch(new DOMException('The operation was aborted', 'AbortError')).fetch,
  });
  await assert.rejects(aborted.directory(), /download failed: raw\.githubusercontent\.com did not answer in time/);

  const timedOut = new ModStore({
    fetch: rejectingFetch(new DOMException('The operation timed out', 'TimeoutError')).fetch,
  });
  await assert.rejects(timedOut.directory(), /download failed: raw\.githubusercontent\.com did not answer in time/);

  const wrappedTimeout = new Error('fetch failed', {
    cause: new DOMException('The operation timed out', 'TimeoutError'),
  });
  const wrapped = new ModStore({ fetch: rejectingFetch(wrappedTimeout).fetch });
  await assert.rejects(wrapped.directory(), /download failed: raw\.githubusercontent\.com did not answer in time/);
});

await test('network failures keep HTTP status and host allow-list errors unchanged', async () => {
  const notFound = serve({});
  const store = new ModStore({ fetch: notFound.fetch });
  await assert.rejects(store.directory(), /download failed: HTTP 404/);

  const evil = serve({
    [DIRECTORY_URL]: { body: directoryJson(goodDirectory()) },
    [BETA_NEW_ZIP_URL]: { status: 302, headers: { location: EVIL_URL } },
  });
  const evilStore = new ModStore({ fetch: evil.fetch });
  await assert.rejects(evilStore.download('beta-mod'), /host not allowed/);
});

const plainStoreMod = (urls: {
  homeURL?: string | null;
  authorURL?: string | null;
  logoURL?: string | null;
}): StoreMod => ({
  id: 'alpha-mod',
  name: 'Alpha Mod',
  description: 'first mod',
  tags: [],
  homeURL: null,
  authorURL: null,
  logoURL: null,
  releases: [],
  ...urls,
});

await test('githubRepoOf reads the GitHub repository of the first URL that carries one', () => {
  assert.equal(githubRepoOf(plainStoreMod({ homeURL: 'https://github.com/acme/mod' })), 'acme/mod');
  assert.equal(githubRepoOf(plainStoreMod({ homeURL: 'https://github.com/acme/mod.git' })), 'acme/mod');
  assert.equal(githubRepoOf(plainStoreMod({ homeURL: 'https://github.com/acme/mod/tree/main/docs' })), 'acme/mod');
  assert.equal(
    githubRepoOf(plainStoreMod({ logoURL: 'https://raw.githubusercontent.com/acme/mod/main/logo.png' })),
    'acme/mod',
  );
  // homeURL wins when several carry a repository, and a non-GitHub homeURL falls through to authorURL.
  assert.equal(
    githubRepoOf(plainStoreMod({ homeURL: 'https://acme.example/', authorURL: 'https://github.com/acme/mod' })),
    'acme/mod',
  );
  assert.equal(githubRepoOf(plainStoreMod({ homeURL: 'https://gitlab.com/acme/mod' })), null);
  assert.equal(githubRepoOf(plainStoreMod({})), null);
});

await test('parseGitHubInput reads the repository and ref of every GitHub shape the Overlay may paste', () => {
  const accepted: Array<[string, { repo: string; ref?: string }]> = [
    ['acme/mod', { repo: 'acme/mod' }],
    ['  acme/mod  ', { repo: 'acme/mod' }],
    ['owner-1.2/my_repo.git', { repo: 'owner-1.2/my_repo' }],
    ['https://github.com/acme/mod', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod/', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod.git', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod.git/', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod?x=1', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod#readme', { repo: 'acme/mod' }],
    // eslint-disable-next-line unicorn/prefer-https -- a pasted plain-http link must still be understood
    ['http://github.com/acme/mod', { repo: 'acme/mod' }],
    ['https://www.github.com/acme/mod', { repo: 'acme/mod' }],
    ['github.com/acme/mod', { repo: 'acme/mod' }],
    ['git@github.com:acme/mod.git', { repo: 'acme/mod' }],
    ['git@github.com:acme/mod', { repo: 'acme/mod' }],
    ['https://github.com/acme/mod/tree/dev', { repo: 'acme/mod', ref: 'dev' }],
    ['https://github.com/acme/mod/tree/dev/docs', { repo: 'acme/mod', ref: 'dev' }],
    ['https://github.com/acme/mod/releases/tag/v1.2.3', { repo: 'acme/mod', ref: 'v1.2.3' }],
    ['https://github.com/acme/mod/blob/main/README.md', { repo: 'acme/mod', ref: 'main' }],
    ['https://github.com/acme/mod/archive/refs/heads/dev.zip', { repo: 'acme/mod', ref: 'dev' }],
    ['https://github.com/acme/mod/archive/refs/tags/v1.2.3.zip', { repo: 'acme/mod', ref: 'v1.2.3' }],
    ['https://github.com/acme/mod/archive/dev.zip', { repo: 'acme/mod', ref: 'dev' }],
  ];

  for (const [input, expected] of accepted) {
    assert.deepEqual(parseGitHubInput(input), expected, input);
  }

  for (const rejected of [
    'https://gitlab.com/a/b',
    'foo',
    '',
    'a/b/c',
    'https://github.com/acme',
    'https://github.com/',
  ]) {
    assert.equal(parseGitHubInput(rejected), null, rejected);
  }
});
