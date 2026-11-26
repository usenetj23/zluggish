import { effectRoutes } from '#src/http/effect';
import { fileResponse } from '#src/http/file-response';
import { t } from '#src/i18n/index';
import { inside } from '#src/http/routes/assets';
import { packageRoot } from '#src/config/load';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { FilesService } from '#src/services/files.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { injectModContent } from '#src/world/mod-content';
import type { ModRegistry } from '#src/world/mods-registry';
import type { OverlayOptIn } from '#src/world/overlay-optin';
import { Effect } from 'effect';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { extname, resolve } from 'node:path';

/**
The vendorated Sauce overlay: the community overlay pages (groups, nearby and their settings windows)
shipped under `assets/sauce/`, served verbatim from `/pages/*` and `/shared/*`.

An `.html` document under `/pages/*` requires a session: without one the request is redirected (302)
to `/`, the web app sign-in page. A signed-in rider who did not opt into the Overlay (see
`world/overlay-optin`, off by default) is redirected (302, `no-store`) to `/overlay` instead. Assets
(scripts, styles, images, fonts, templates) stay anonymous,
also under `/shared/*`. The redirect exists because a signed-out widget would otherwise open an empty
window whose every data call fails with a 401 in the console; the sign-in page is a useful answer.

Caching: only fonts and large static media (see `longCached`) are kept by the browser for an hour;
every other asset is `no-cache` so an update reaches the browser on the next revalidation.

The session is resolved the way the Sauce API viewer is in `widget-api.ts`, but read straight from
the session cookie: the `/api/*` session middleware is not part of the `/pages/*` chain, and a valid
`zluggish_web_session` cookie checked against the session store means signed in (unknown, ended or
expired sessions answer nothing and stay signed out).

`inside` (shared with `assets.ts`) keeps the request inside the vendored root; `FilesService.isFile`
then rejects directories and anything that is not a regular file.
*/

export const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  // Layout templates fetched at run time by the Watching page (a static scan of the pages misses them).
  ['.tpl', 'text/plain; charset=utf-8'],
]);

/**
These pages declare `'unsafe-eval'` in their own meta-CSP because their template engine compiles
functions (`new (function(){}).constructor(source)`); the two Watching pages are the ONLY pages we
give it to.
Do not add anything here without first reading why; `'unsafe-inline'` in `script-src` is NEVER granted.
*/
const evalPages = new Set(['/pages/watching.html', '/pages/watching-settings.html']);

/** A `Host` header only ever reaches the CSP policy when it looks like a host, port or IPv6 literal. */
const hostHeader = /^[A-Za-z0-9.\-:[\]]+$/;

/** Fonts and large static media may stay in the browser cache for an hour; everything else revalidates. */
const longCached = new Set(['.woff2', '.webp']);

/**
Sauce pages other pages link to (the athlete profile from Groups and Nearby, the buttons of the
Overview bar) that Zluggish does not ship. Instead of a blank 404 window they get this small Zluggish-written document;
`style-src 'unsafe-inline'` of `pagePolicy` allows its inline style.
*/
const unavailablePages = new Set([
  '/pages/profile.html',
  '/pages/profile-avatar.html',
  '/pages/athletes.html',
  '/pages/events.html',
  '/pages/analysis.html',
  '/pages/geo.html',
]);
const unavailablePage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('overlay_page_unavailable_title')}</title>
<style>
body { background: #1b1b1f; color: #e8e8ec; font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
</style>
</head>
<body>
<p>${t('overlay_page_unavailable')}</p>
</body>
</html>
`;

/** CSP source expressions for SHA-256 digests. */
const digests = (hashes: ReadonlyArray<string>) => hashes.map((hash) => ` 'sha256-${hash}'`).join('');

/** What a page may do beyond the plain page policy. */
export interface PagePermissions {
  /** `'unsafe-eval'`, for the pages whose template engine compiles functions. */
  allowEval?: boolean;
  /** The CSP digests of the inline scripts of a mod page (see `inlineScriptHashes`). */
  scriptHashes?: ReadonlyArray<string>;
  /** The CSP digests of the inline event handler attributes of a mod page (see `inlineHandlerHashes`). */
  handlerHashes?: ReadonlyArray<string>;
  /** A mod the administrator granted the network: images, media, styles, fonts and fetches from other hosts. */
  network?: boolean;
}

/**
The page policy replaces the global one for these documents: the pages talk to this server over a
WebSocket, so `connect-src` adds the same host the page was loaded from. Scripts stay `'self'` only —
the vendored inline scripts were moved to files precisely because inline scripts are forbidden. A mod
page gets the digests of its OWN inline scripts and handlers, never `'unsafe-inline'` and never
`'unsafe-eval'`. A mod granted the network may reach other hosts for everything but scripts, so
third-party CODE stays forbidden. `frame-ancestors 'self'`: a page may only be framed by a page of this
same server, never by another site.
*/
export function pagePolicy(url: string, host: string | undefined, permissions: PagePermissions = {}): string {
  const { allowEval = false, scriptHashes = [], handlerHashes = [], network = false } = permissions;
  const scheme = url.startsWith('https:') ? 'wss' : 'ws';
  const socket = host && hostHeader.test(host) ? ` ${scheme}://${host}` : '';
  const scripts = `script-src 'self'${allowEval ? " 'unsafe-eval'" : ''}${digests(scriptHashes)};`;
  const attributes = handlerHashes.length > 0 ? ` script-src-attr 'unsafe-hashes'${digests(handlerHashes)};` : '';

  if (!network) {
    return `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scripts}${attributes} connect-src 'self'${socket}; frame-ancestors 'self'; base-uri 'none'`;
  }

  return `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; ${scripts}${attributes} connect-src 'self'${socket} https: wss:; frame-ancestors 'self'; base-uri 'none'`;
}

export function widgetStaticRoutes(
  app: Hono<WebEnv>,
  runtime: HttpRuntime,
  registry: ModRegistry,
  optIn: OverlayOptIn,
): void {
  const appRoutes = effectRoutes(app, runtime);
  const root = resolve(packageRoot(), '../assets/sauce');
  const sessions = runtime.effects.runSync(WebSessionsService);

  // The viewer rule of `widgetApiRoutes` in `widget-api.ts` (session id, then the session store),
  // applied to the cookie directly: the `/api/*` middleware that sets `sessionId` does not run for
  // `/pages/*`, and `sessions.find` answers null for an unknown, ended or expired session.
  const signedIn = (c: Context<WebEnv, string>): boolean => sessionOf(c) !== null;

  const sessionOf = (c: Context<WebEnv, string>) =>
    runtime.effects.runSync(sessions.find(getCookie(c, 'zluggish_web_session')));

  // The rider of a session: its identity is `<player_id>:<auth_version>` (see `identityOf` of
  // `services/auth.service.ts`), and an identity the session store would not resolve has no rider.
  const riderOf = (c: Context<WebEnv, string>): number | null => {
    const session = sessionOf(c);

    if (!session) {
      return null;
    }
    const playerId = Number(session.identity.split(':', 1)[0]);

    return Number.isSafeInteger(playerId) && playerId > 0 ? playerId : null;
  };

  const serve = (prefix: string) =>
    appRoutes.get(`${prefix}/*`, (c) =>
      Effect.gen(function* () {
        const filesService = yield* FilesService;

        // Each prefix has its own root, so `/shared/%2e%2e%2fATTRIBUTION.md` stays inside `shared/`.
        const file = inside(resolve(root, prefix.slice(1)), c.req.path.slice(prefix.length));

        if (!file) {
          return c.notFound();
        }

        const extension = extname(file);
        const html = extension === '.html';
        const path = c.req.path;

        // An HTML document of `/pages/*` with no session goes to the sign-in page instead of a widget
        // that would sit empty; the redirect is `no-store` so a signed-out answer is never cached.
        if (html && prefix === '/pages' && !signedIn(c)) {
          c.header('Cache-Control', 'no-store');

          return c.redirect('/', 302);
        }

        // A signed-in rider whose Overlay pages are off (the default, see `world/overlay-optin`) gets
        // the web app's `/overlay` page instead of a widget; `no-store` keeps a stale answer out of
        // the browser cache once the rider opts in.
        if (html && prefix === '/pages') {
          const rider = riderOf(c);

          if (rider !== null && !optIn.enabled(rider)) {
            c.header('Cache-Control', 'no-store');

            return c.redirect('/overlay', 302);
          }
        }

        // A page other pages link to that Zluggish does not ship: a written notice, never a blank 404.
        if (!(yield* filesService.isFile(file))) {
          if (html && unavailablePages.has(path)) {
            return c.body(unavailablePage(), 200, {
              'Content-Type': types.get('.html') ?? 'application/octet-stream',
              'Cache-Control': 'no-cache',
              'Content-Security-Policy': pagePolicy(c.req.url, c.req.header('Host')),
            });
          }

          return c.notFound();
        }

        const headers = {
          'Content-Type': types.get(extension) ?? 'application/octet-stream',
          'Cache-Control': html || !longCached.has(extension) ? 'no-cache' : 'public, max-age=3600',
          ...(html && {
            'Content-Security-Policy': pagePolicy(c.req.url, c.req.header('Host'), { allowEval: evalPages.has(path) }),
          }),
        };

        // The content scripts and styles of the enabled mods reach every widget page, the settings pages
        // included, as Sauce injects them into every window. Without any, the page streams untouched.
        if (html && prefix === '/pages') {
          const content = registry.contentFiles();

          if (content.scripts.length + content.styles.length > 0) {
            return c.body(injectModContent(yield* filesService.readText(file), content), 200, headers);
          }
        }

        return yield* fileResponse(c, file, headers);
      }),
    );

  serve('/pages');
  serve('/shared');
}
