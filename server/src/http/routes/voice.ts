import { effectRoutes } from '#src/http/effect';
import type { HttpRuntime as Runtime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { VoiceService } from '#src/services/voice.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { Effect } from 'effect';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

/**
The ride read aloud: every chat bubble of the game and every block of a
running workout arrive as server-sent events; the Voice page of the web
app streams them and the browser speaks them.
*/
export function voiceRoutes(app: Hono<WebEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  appRoutes.get('/api/voice/stream', (c) =>
    Effect.gen(function* () {
      const webSessionsService = yield* WebSessionsService;

      const voiceService = yield* VoiceService;

      const user = yield* webSessionsService.require(c.get('sessionId'));
      const language = c.req.query('language') === 'en' ? 'en' : 'pl';

      return streamSSE(c, async (stream) => {
        const unsubscribe = Effect.runSync(
          voiceService.subscribe(
            user.player_id,
            language,
            (event) => void stream.writeSSE({ event: event.kind, data: JSON.stringify(event) }),
          ),
        );

        const keepAlive = setInterval(() => void stream.write(': ping\n\n'), 15_000);

        await new Promise<void>((done) => {
          stream.onAbort(() => {
            clearInterval(keepAlive);
            unsubscribe();
            done();
          });
        });
      });
    }),
  );
}
