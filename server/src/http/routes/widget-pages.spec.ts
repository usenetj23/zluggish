import { pagePolicy } from '#src/http/routes/widget-pages';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
`pagePolicy` of `widget-pages.ts`: the Content-Security-Policy of every vendored widget page. Scripts
stay on this server, the event socket may reach the host the page came from, and only the pages that
compile templates are given `'unsafe-eval'`.
*/

const origin = 'http://local:8080';

await test('the page policy keeps scripts to this server and opens the event socket of the page host', () => {
  const policy = pagePolicy(origin, 'local:8080');

  assert.equal(
    policy,
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://local:8080; frame-ancestors 'self'; base-uri 'none'",
  );
});

await test('a page served over https gets a wss socket, and an eval page gets unsafe-eval in script-src only', () => {
  const policy = pagePolicy('https://local:8443/pages/watching.html', 'local:8443', { allowEval: true });

  assert.ok(policy.includes("script-src 'self' 'unsafe-eval';"), policy);
  assert.ok(policy.includes("connect-src 'self' wss://local:8443;"), policy);
  const scripts = policy.split(';').find((directive) => directive.trimStart().startsWith('script-src')) ?? '';

  assert.ok(!scripts.includes('unsafe-inline'), policy);
});

await test('a Host header that does not look like a host is left out of connect-src', () => {
  const policy = pagePolicy(origin, 'evil.example; script-src *');

  assert.ok(policy.includes("connect-src 'self';"), policy);
  assert.ok(!policy.includes('evil.example'), policy);
});

await test('without a Host header connect-src stays on this server', () => {
  assert.ok(pagePolicy(origin, undefined).includes("connect-src 'self';"));
});

await test('a mod page gets the digests of its own inline scripts and handlers, never unsafe-inline', () => {
  const policy = pagePolicy(origin, 'local:8080', { scriptHashes: ['abc='], handlerHashes: ['def='] });

  assert.ok(policy.includes("script-src 'self' 'sha256-abc=';"), policy);
  assert.ok(policy.includes("script-src-attr 'unsafe-hashes' 'sha256-def=';"), policy);
  assert.ok(!policy.includes("'unsafe-inline' 'sha256"), policy);
  assert.ok(!policy.includes("'unsafe-eval'"), policy);
});

await test('a mod granted the network reaches other hosts for everything but scripts', () => {
  const plain = pagePolicy(origin, 'local:8080');
  const policy = pagePolicy(origin, 'local:8080', { network: true });

  assert.ok(policy.includes("img-src 'self' data: blob: https:;"), policy);
  assert.ok(policy.includes("connect-src 'self' ws://local:8080 https: wss:;"), policy);
  assert.ok(policy.includes("script-src 'self';"), policy);
  assert.equal(pagePolicy(origin, 'local:8080', { network: false }), plain);
});
