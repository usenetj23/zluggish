import { effectRoutes } from '#src/http/effect';
import type { HttpRuntime as Runtime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { WebSessionsService } from '#src/services/web-session.service';
import { Strict } from '#src/schema';
import type { OverlayOptIn } from '#src/world/overlay-optin';
import { Effect, Schema } from 'effect';
import type { Hono } from 'hono';

/**
The Sauce Overlay opt-in of the signed-in rider: `GET /api/me/overlay` answers whether the rider's
Overlay pages are on, `PUT /api/me/overlay` turns them on or off and answers the new state. Off is the
default; while a rider is off, an HTML document under `/pages/*` redirects to `/` instead of opening
a widget (see `widgetStaticRoutes`).

Both handlers are plain `/api/me/*` routes: the `/api/*` middleware of `web-app.ts` already demands a
session for the id and, for a mutating method, the same-origin and the CSRF header, exactly like for
`/api/me/settings`; a body that is not exactly `{ enabled: boolean }` is a schema error and `onError`
answers it 400.
*/
export function overlayRoutes(app: Hono<WebEnv>, runtime: Runtime, optIn: OverlayOptIn): void {
  const appRoutes = effectRoutes(app, runtime);

  appRoutes.get('/api/me/overlay', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      return c.json({ enabled: optIn.enabled(player) });
    }),
  );

  appRoutes.put('/api/me/overlay', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const player = (yield* webSessionsService.require(c.get('sessionId'))).player_id;

      const { enabled } = Schema.decodeUnknownSync(Strict({ enabled: Schema.Boolean }))(
        yield* Effect.promise(() => c.req.json()),
      );

      optIn.set(player, enabled);

      return c.json({ enabled });
    }),
  );
}
