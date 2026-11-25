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
  const policy = pagePolicy(origin, 'local:8080', false);

  assert.equal(
    policy,
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://local:8080; frame-ancestors 'self'; base-uri 'none'",
  );
});

await test('a page served over https gets a wss socket, and an eval page gets unsafe-eval in script-src only', () => {
  const policy = pagePolicy('https://local:8443/pages/watching.html', 'local:8443', true);

  assert.ok(policy.includes("script-src 'self' 'unsafe-eval';"), policy);
  assert.ok(policy.includes("connect-src 'self' wss://local:8443;"), policy);
  const scripts = policy.split(';').find((directive) => directive.trimStart().startsWith('script-src')) ?? '';

  assert.ok(!scripts.includes('unsafe-inline'), policy);
});

await test('a Host header that does not look like a host is left out of connect-src', () => {
  const policy = pagePolicy(origin, 'evil.example; script-src *', false);

  assert.ok(policy.includes("connect-src 'self';"), policy);
  assert.ok(!policy.includes('evil.example'), policy);
});

await test('without a Host header connect-src stays on this server', () => {
  assert.ok(pagePolicy(origin, undefined, false).includes("connect-src 'self';"));
});
