import { inlineHandlerHashes, inlineScriptHashes } from '#src/world/inline-scripts';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const crypto = new CryptoRepository();

function sha256Hex(data: string): string {
  return crypto.sha256(data);
}

function expectedBase64(content: string): string {
  return Buffer.from(sha256Hex(content), 'hex').toString('base64');
}

await test('one inline module script yields one digest of its exact content', () => {
  const content = 'const hill = 1;\nrender(hill);';
  const html = `<html><body><script type="module">${content}</script></body></html>`;

  assert.deepEqual(inlineScriptHashes(html, sha256Hex), [expectedBase64(content)]);
});

await test('scripts with a src attribute are skipped', () => {
  const html = '<script src="x.js"></script><script>let b = 2;</script>';

  assert.deepEqual(inlineScriptHashes(html, sha256Hex), [expectedBase64('let b = 2;')]);
});

await test('identical scripts deduplicate, different scripts keep first-seen order', () => {
  const first = 'let a = 1;';
  const second = 'let b = 2;';
  const same = `<script>${first}</script><script>${first}</script>`;
  const different = `<script>${first}</script><script>${second}</script>`;

  assert.deepEqual(inlineScriptHashes(same, sha256Hex), [expectedBase64(first)]);
  assert.deepEqual(inlineScriptHashes(different, sha256Hex), [expectedBase64(first), expectedBase64(second)]);
});

await test('a script inside an HTML comment is still hashed', () => {
  // The regex does not parse comments, so a commented-out script contributes a digest. This is
  // harmless: the commented script never runs, and its digest only allows an identical script.
  const content = 'let commented = 1;';
  const html = `<!-- <script>${content}</script> -->`;

  assert.deepEqual(inlineScriptHashes(html, sha256Hex), [expectedBase64(content)]);
});

await test('type attributes and uppercase tags are matched', () => {
  const moduleContent = 'import "mod";';
  const upperContent = 'let upper = 1;';
  const html = `<script type="module">${moduleContent}</script><SCRIPT TYPE="module">${upperContent}</SCRIPT>`;

  assert.deepEqual(inlineScriptHashes(html, sha256Hex), [expectedBase64(moduleContent), expectedBase64(upperContent)]);
});

await test('zero-length script content is skipped, whitespace-only content is hashed', () => {
  const whitespace = '\n  \t';
  const html = `<script></script><script>${whitespace}</script>`;

  assert.deepEqual(inlineScriptHashes(html, sha256Hex), [expectedBase64(whitespace)]);
});

await test('more than twenty inline scripts throws', () => {
  const html = Array.from({ length: 21 }, (_, index) => `<script>let n = ${index};</script>`).join('');

  assert.throws(() => inlineScriptHashes(html, sha256Hex), /too many inline scripts/);
});

await test('a single script longer than 256 KiB throws', () => {
  const huge = 'x'.repeat(256 * 1024 + 1);

  assert.throws(() => inlineScriptHashes(`<script>${huge}</script>`, sha256Hex), /inline script too large/);
});

await test('known content hashes to its computed base64 SHA-256', () => {
  const content = 'console.log(1)';
  const expected = expectedBase64(content);

  assert.equal(expected.length, 44, 'a SHA-256 base64 digest is 44 characters');
  assert.deepEqual(inlineScriptHashes(`<script>${content}</script>`, sha256Hex), [expected]);
});

await test('an onclick handler yields one digest of its exact value', () => {
  const html = '<button onclick="go()">go</button>';

  assert.deepEqual(inlineHandlerHashes(html, sha256Hex), [expectedBase64('go()')]);
});

await test('single-quoted and unquoted handler values are hashed', () => {
  const html = "<input onchange='f(this.value)'><div onmouseover=g()>z</div>";

  assert.deepEqual(inlineHandlerHashes(html, sha256Hex), [expectedBase64('f(this.value)'), expectedBase64('g()')]);
});

await test('HTML entities in a handler value are decoded before hashing', () => {
  const html = '<button onclick="say(&quot;x&quot;)">x</button>';

  assert.deepEqual(inlineHandlerHashes(html, sha256Hex), [expectedBase64('say("x")')]);
});

await test('identical handlers deduplicate, different ones keep first-seen order', () => {
  const html = '<a onclick="go()">a</a><b onclick="go()">b</b><c onchange="f()">c</c>';

  assert.deepEqual(inlineHandlerHashes(html, sha256Hex), [expectedBase64('go()'), expectedBase64('f()')]);
});

await test('the word onclick= in a text node is not a handler', () => {
  const html = '<p>onclick= is not executed here</p>';

  assert.deepEqual(inlineHandlerHashes(html, sha256Hex), []);
});

await test('a tag without any handler gives no digest, empty values are skipped', () => {
  assert.deepEqual(inlineHandlerHashes('<div class="x"><span id="y"></span></div>', sha256Hex), []);
  assert.deepEqual(inlineHandlerHashes('<button onclick="">x</button>', sha256Hex), []);
});

await test('more than two hundred distinct handlers throws', () => {
  const html = Array.from({ length: 201 }, (_, index) => `<button onclick="g${index}()">x</button>`).join('');

  assert.throws(() => inlineHandlerHashes(html, sha256Hex), /too many inline handlers/);
});

await test('a handler value longer than 16 KiB throws', () => {
  const huge = 'x'.repeat(16 * 1024 + 1);

  assert.throws(
    () => inlineHandlerHashes(`<button onclick="${huge}">x</button>`, sha256Hex),
    /inline handler too large/,
  );
});
