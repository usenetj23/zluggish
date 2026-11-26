import { t } from '#src/i18n/index';
import { effectRoutes } from '#src/http/effect';
import { fileResponse } from '#src/http/file-response';
import { pagePolicy, types } from '#src/http/routes/widget-pages';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { FilesService } from '#src/services/files.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { inlineHandlerHashes, inlineScriptHashes } from '#src/world/inline-scripts';
import { injectFieldsModule, injectModContent, modernizeImportAssertions } from '#src/world/mod-content';
import { isSafePath } from '#src/world/mods-core';
import type { ModRegistry } from '#src/world/mods-registry';
import { Effect } from 'effect';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { extname } from 'node:path';

/**
Mod web content served over HTTP: a mod declares `web_root` in its manifest and its files under that
prefix become reachable at `/mods/<id>/<web_root>/<file>`.

Only GET is registered, so every other method on `/mods/*` simply does not match. The signature rule
is the one of `widgetStaticRoutes`: a valid `zluggish_web_session` cookie checked against the session
store means signed in. A `.html` document without a session is redirected (302, `no-store`) to `/`,
the sign-in page; any other asset answers `401` instead.

The path is percent-decoded before it is checked: a backslash, a NUL byte or a path `isSafePath`
rejects never reaches the registry, and the request must stay inside the declared `web_root` OR be
one of the `content_js` / `content_css` files of the mod (they may live outside the web root, and a
mod without a `web_root` serves nothing but those). The registry itself (`ModRegistry.fileOf`) then
resolves the file, rejecting anything outside the mod directory and anything that is not a regular
file.

HTML documents are read and served with a page policy whose `script-src` carries the digests of the
page's OWN inline scripts (`inlineScriptHashes`): mod pages never get `'unsafe-inline'` and never
`'unsafe-eval'`; a page whose inline scripts cannot be hashed (too many, too large) answers 422. The
files themselves are content-pinned by the registry. Other assets stream through `fileResponse`.
Before a mod page is served, the `content_js` / `content_css` URLs of ALL active mods are injected
into it (`injectModContent`), exactly as Sauce injects them into every window; the injected tags are
external, so the digests of the page's own inline scripts do not change.
*/
export function modStaticRoutes(app: Hono<WebEnv>, runtime: HttpRuntime, registry: ModRegistry): void {
  const appRoutes = effectRoutes(app, runtime);
  const sessions = runtime.effects.runSync(WebSessionsService);

  // The viewer rule of `widgetStaticRoutes` (the session cookie checked against the session store);
  // `sessions.find` answers null for an unknown, ended or expired session.
  const signedIn = (c: Context<WebEnv, string>): boolean =>
    !!runtime.effects.runSync(sessions.find(getCookie(c, 'zluggish_web_session')));

  appRoutes.get('/mods/:id/*', (c) =>
    Effect.gen(function* () {
      const path = c.req.path;

      // A `.html` document with no session goes to the sign-in page; other assets answer 401.
      if (!signedIn(c)) {
        if (extname(path) === '.html') {
          c.header('Cache-Control', 'no-store');

          return c.redirect('/', 302);
        }

        return c.text(t('widget_sign_in_first'), 401);
      }

      const id = c.req.param('id');
      const remainder = path.slice(`/mods/${id}/`.length);

      let rest: string;

      try {
        rest = decodeURIComponent(remainder);
      } catch {
        return c.notFound();
      }

      if (rest.includes('\\') || rest.includes('\0') || !isSafePath(rest)) {
        return c.notFound();
      }

      const entry = registry.get(id);

      const webRoot = entry?.manifest?.web_root;
      const inWebRoot = !!webRoot && rest.startsWith(`${webRoot}/`);

      // Content scripts and styles may live outside the web root; without a web root a mod serves
      // ONLY those declared content files.
      // The entry is resolved once and reused below (`entryIsContentFile`, `entryFileOf`), so one
      // request pays for the (cached) registry scan once instead of once per helper.
      if (!entry || entry.status !== 'active' || (!inWebRoot && !registry.entryIsContentFile(entry, rest))) {
        return c.notFound();
      }

      const file = registry.entryFileOf(entry, rest);

      if (!file) {
        return c.notFound();
      }

      const extension = extname(file.absolute);

      if (extension === '.mjs' || extension === '.js') {
        const filesService = yield* FilesService;
        const source = yield* filesService.readText(file.absolute);

        // Old mods import JSON with `assert { type: 'json' }`, which the runner's Chromium no longer accepts.
        return c.body(source.includes('assert') ? modernizeImportAssertions(source) : source, 200, {
          'Content-Type': types.get(extension) ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        });
      }

      if (extension !== '.html') {
        return yield* fileResponse(c, file.absolute, {
          'Content-Type': types.get(extension) ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        });
      }

      const filesService = yield* FilesService;
      // A browser normalizes CRLF and lone CR to LF while it parses a document, and a CSP digest is taken over
      // the normalized text; hashing the raw bytes of a CRLF page (Zenmaster, O101) would not match and every
      // inline script of it would be blocked. So the page is normalized here, before it is hashed and served.
      const html = (yield* filesService.readText(file.absolute)).replaceAll(/\r\n?/g, '\n');
      const crypto = new CryptoRepository();

      let hashes: Array<string>;
      let handlerHashes: Array<string>;

      try {
        hashes = inlineScriptHashes(html, (data) => crypto.sha256(data));
        handlerHashes = inlineHandlerHashes(html, (data) => crypto.sha256(data));
      } catch {
        // `too many inline scripts`, `inline script too large`, `too many inline handlers` or
        // `inline handler too large`: the page cannot be pinned.
        return c.text(t('widget_mod_page_unservable'), 422);
      }

      const body = injectFieldsModule(injectModContent(html, registry.contentFiles()));

      return c.body(body, 200, {
        'Content-Type': types.get('.html') ?? 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': pagePolicy(c.req.url, c.req.header('Host'), {
          scriptHashes: hashes,
          handlerHashes,
          network: entry.network,
        }),
      });
    }),
  );
}
