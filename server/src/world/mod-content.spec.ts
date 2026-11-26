import { injectFieldsModule, injectModContent, modernizeImportAssertions } from '#src/world/mod-content';
import type { ModContent } from '#src/world/mod-content';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const EMPTY: ModContent = { scripts: [], styles: [] };
const SCRIPT = '/mods/zenmaster/pages/src/data-fields.js';
const STYLE = '/mods/zenmaster/pages/src/data-fields.css';

function page(head = '<head><title>t</title></head>'): string {
  return `<!doctype html><html>${head}<body><div id="app"></div></body></html>`;
}

await test('nothing to inject returns the identical string', () => {
  const html = page();

  assert.strictEqual(injectModContent(html, EMPTY), html);
  assert.strictEqual(injectModContent(html, { scripts: [], styles: [] }), html);
});

await test('styles and scripts land before </head>, styles before scripts', () => {
  const html = page();

  const out = injectModContent(html, { scripts: [SCRIPT], styles: [STYLE] });

  const styleAt = out.indexOf(`<link rel="stylesheet" href="${STYLE}"/>`);
  const scriptAt = out.indexOf(`<script src="${SCRIPT}"></script>`);
  const headCloseAt = out.indexOf('</head>');

  assert.ok(styleAt !== -1 && scriptAt !== -1);
  assert.ok(styleAt < scriptAt);
  assert.ok(scriptAt < headCloseAt);
  assert.ok(out.includes(`</script>\n</head>`));
});

await test('uppercase </HEAD> is matched', () => {
  const html = page('<HEAD><title>t</title></HEAD>');

  const out = injectModContent(html, { scripts: [SCRIPT], styles: [] });

  assert.ok(out.includes(`<script src="${SCRIPT}"></script>\n</HEAD>`));
});

await test('a page with <body class="x"> and no head gets the block right after the body tag', () => {
  const html = '<html><body class="x"><div id="app"></div></body></html>';

  const out = injectModContent(html, { scripts: [SCRIPT], styles: [STYLE] });

  assert.ok(
    out.startsWith(
      `<html><body class="x">\n    <link rel="stylesheet" href="${STYLE}"/>\n    <script src="${SCRIPT}"></script>\n<div`,
    ),
  );
});

await test('a fragment with neither head nor body gets the block prepended', () => {
  const html = '<div id="app"></div>';

  const out = injectModContent(html, { scripts: [SCRIPT], styles: [] });

  assert.strictEqual(out, `\n    <script src="${SCRIPT}"></script>\n<div id="app"></div>`);
});

await test('attribute-significant characters are escaped', () => {
  const nasty = '/mods/a/b.css?x="1"&y=<2>';
  const html = page();

  const out = injectModContent(html, { scripts: [], styles: [nasty] });

  assert.ok(out.includes('<link rel="stylesheet" href="/mods/a/b.css?x=&quot;1&quot;&amp;y=&lt;2&gt;"/>'));
  assert.ok(!out.includes('x="1"'));
  assert.ok(!out.includes('y=<2>'));
});

await test('injecting twice with the same content gives the same result as once', () => {
  const content: ModContent = { scripts: [SCRIPT], styles: [STYLE] };
  const html = page();

  const once = injectModContent(html, content);
  const twice = injectModContent(once, content);

  assert.strictEqual(twice, once);
});

await test('a </head> inside an HTML comment before the real one is matched first', () => {
  // The regex does not parse comments, so the first `</head>` wins even inside a comment. This is
  // acceptable: the window pages are controlled files with no commented-out head tags.
  const html = `<html><head><!-- close it: </head> --><title>t</title></head><body></body></html>`;

  const out = injectModContent(html, { scripts: [SCRIPT], styles: [] });

  const injectedAt = out.indexOf(`<script src="${SCRIPT}"></script>`);
  const commentedAt = out.indexOf('</head>');
  const realAt = out.lastIndexOf('</head>');

  assert.ok(injectedAt < commentedAt && commentedAt < realAt);
});

await test('injectFieldsModule puts the fields module first in the head, once, and leaves a page without a head alone', () => {
  const page = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const injected = injectFieldsModule(page);

  assert.ok(injected.indexOf('/pages/src/fields.mjs') < injected.indexOf('<title>'));
  assert.equal(injectFieldsModule(injected), injected);
  assert.equal(injectFieldsModule('<!doctype html><title>x</title>'), '<!doctype html><title>x</title>');
});

await test('modernizeImportAssertions rewrites only the assert keyword of an import statement', () => {
  assert.equal(
    modernizeImportAssertions("import crr from './crr.json' assert { type: 'json' };"),
    "import crr from './crr.json' with { type: 'json' };",
  );
  assert.equal(modernizeImportAssertions('const assert = 1; assert { };'), 'const assert = 1; assert { };');
});
