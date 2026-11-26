import type { Schema } from 'effect';
import { isSafeId, isSafePath, ModValidationError, sanitizeId, validateManifest } from '#src/world/mods-core';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const WINDOW = {
  file: 'pages/hill-radar.html',
  id: 'hill-radar',
  name: 'Hill Radar',
  description: 'd',
  overlay: true,
  frame: false,
  default_bounds: { width: 380, height: 300, x: -400, y: 100 },
} satisfies Readonly<Record<string, typeof Schema.Json.Type>>;

const VALID = {
  manifest_version: 1,
  id: 'hill-radar',
  name: 'Hill Radar',
  description: 'Climb detection',
  author: 'A',
  website_url: 'https://example.com',
  version: '0.5.0',
  content_css: [],
  web_root: 'pages',
  windows: [WINDOW],
} satisfies Readonly<Record<string, typeof Schema.Json.Type>>;

function withChanges(changes: Readonly<Record<string, typeof Schema.Json.Type>>) {
  return { ...structuredClone(VALID), ...changes };
}

interface InvalidCase {
  readonly name: string;
  readonly manifest: unknown;
  readonly message: string;
  readonly key?: string | undefined;
  readonly path?: Array<string>;
}

const INVALID_CASES: Array<InvalidCase> = [
  { name: 'unknown key', manifest: withChanges({ extra: 1 }), message: 'Unexpected key', key: 'extra' },
  {
    name: 'missing name',
    manifest: (() => {
      return Object.fromEntries(Object.entries(withChanges({})).filter(([key]) => key !== 'name'));
    })(),
    message: 'Missing required key(s): name',
    key: undefined,
  },
  { name: 'manifest_version 2', manifest: withChanges({ manifest_version: 2 }), message: 'Invalid value: "2"' },
  { name: 'id with space', manifest: withChanges({ id: 'a b' }), message: 'Invalid value: "a b"' },
  { name: 'web_root escape', manifest: withChanges({ web_root: '../x' }), message: 'Invalid value: "../x"' },
  {
    name: 'content_js not an array',
    manifest: withChanges({ content_js: 'a.js' }),
    message: 'Invalid type, expected "array"',
    key: 'content_js',
  },
  {
    name: 'content_js absolute path',
    manifest: withChanges({ content_js: ['/abs.js'] }),
    message: 'Invalid value: "/abs.js"',
    key: 'content_js[0]',
  },
  {
    name: 'duplicate window id',
    manifest: withChanges({
      windows: [WINDOW, { ...structuredClone(WINDOW), file: 'pages/other.html', name: 'Other' }],
    }),
    message: 'Duplicate value for unique field: "hill-radar"',
    key: 'id',
  },
  {
    name: 'window query value not a string',
    manifest: withChanges({ windows: [{ ...structuredClone(WINDOW), query: { a: 1 } }] }),
    message: 'Invalid type, expected "string"',
    key: 'a',
  },
  {
    name: 'negative width',
    manifest: withChanges({ windows: [{ ...structuredClone(WINDOW), default_bounds: { width: -1 } }] }),
    message: 'Invalid value: "-1"',
    key: 'width',
  },
  {
    name: 'window without file',
    manifest: (() => {
      const window = Object.fromEntries(Object.entries(structuredClone(WINDOW)).filter(([key]) => key !== 'file'));
      return withChanges({ windows: [window] });
    })(),
    message: 'Missing required key(s):',
    key: undefined,
    path: ['windows[0]'],
  },
  { name: 'name is a number', manifest: withChanges({ name: 5 }), message: 'Invalid type, expected "string"' },
];

await test('the Hill Radar manifest validates without warnings', { timeout: 10_000 }, () => {
  const { manifest, warnings } = validateManifest(structuredClone(VALID));

  assert.equal(manifest.id, 'hill-radar');
  assert.deepEqual(warnings, []);
});

await test('invalid manifests raise ModValidationError with the expected message', { timeout: 10_000 }, () => {
  for (const testCase of INVALID_CASES) {
    assert.throws(
      () => validateManifest(testCase.manifest),
      (error: unknown) => {
        assert.ok(error instanceof ModValidationError, `${testCase.name}: not a ModValidationError`);
        assert.ok(error.message.startsWith(testCase.message), `${testCase.name}: "${error.message}"`);
        if (testCase.path !== undefined) {
          assert.deepEqual([...error.path], testCase.path);
        }
        if ('key' in testCase) {
          assert.equal(error.key, testCase.key);
        }
        return true;
      },
      testCase.name,
    );
  }
});

await test('root values that are not plain objects are rejected', { timeout: 10_000 }, () => {
  for (const root of [5, [], null]) {
    assert.throws(
      () => validateManifest(root),
      (error: unknown) => {
        assert.ok(error instanceof ModValidationError);
        assert.equal(error.message, 'Invalid manifest root type: expected object');
        assert.deepEqual([...error.path], []);
        assert.equal(error.key, undefined);
        return true;
      },
      `root ${JSON.stringify(root)}`,
    );
  }
});

await test('always_visible validates and warns as deprecated', { timeout: 10_000 }, () => {
  const { warnings } = validateManifest(
    withChanges({ windows: [{ ...structuredClone(WINDOW), always_visible: true }] }),
  );

  assert.deepEqual(warnings, ['Deprecated field "windows[0].always_visible"']);
});

await test('isSafePath accepts relative safe paths only', { timeout: 10_000 }, () => {
  for (const [value, expected] of [
    ['pages/a.js', true],
    ['a_b-c.d/e', true],
    ['/abs', false],
    ['a/../b', false],
    ['.hidden', false],
    ['a b', false],
    ['', false],
  ] as Array<[string, boolean]>) {
    assert.equal(isSafePath(value), expected, `isSafePath(${JSON.stringify(value)})`);
  }
});

await test('isSafeId accepts only bare identifiers', { timeout: 10_000 }, () => {
  for (const [value, expected] of [
    ['hill-radar', true],
    ['a_b', true],
    ['a b', false],
    ['a.b', false],
  ] as Array<[string, boolean]>) {
    assert.equal(isSafeId(value), expected, `isSafeId(${JSON.stringify(value)})`);
  }
});

await test('sanitizeId replaces unsafe characters with dashes', { timeout: 10_000 }, () => {
  assert.equal(sanitizeId('a b.c'), 'a-b-c');
});
