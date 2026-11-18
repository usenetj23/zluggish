import type { Hono } from 'hono';
import { resolve } from 'node:path';
import { z } from 'zod';
import { UploadProvider } from '#src/enum';
import { ApplicationError, UnreadableCredentialsError } from '#src/errors';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { GARMIN_DEVICES, defaultSerial, deviceText, parseDeviceIdentity } from '#src/world/fit-device';

const provider = z.enum(['strava', 'garmin', 'intervals']);
const credentials = z.strictObject({ username: z.string().trim().min(1).max(500), secret: z.string().max(10_000) });
const workoutProviders = { intervals: 'intervals-icu', trainingpeaks: 'trainingpeaks' } as const;

const credential = z.enum([
  'strava/api',
  'strava/authorization',
  'strava/cookie',
  'garmin/credentials',
  'garmin/authorization',
]);

/** Credentials stored as rider documents. Removing the Garmin OAuth1 token also removes its OAuth2 token. */
const tokens = {
  'strava/authorization': 'strava_token.txt',
  'strava/cookie': 'strava4_session.txt',
  'garmin/authorization': 'garth/oauth1_token.json',
} as const;

/** A provider failure becomes a message for the rider and a warning with the cause for the
operator. Unreadable credentials keep their own answer: the rider must enter them again.
*/
export function providerFailure(runtime: HttpRuntime, cause: unknown, status: 400 | 503, message: string) {
  if (cause instanceof UnreadableCredentialsError) return cause;
  runtime.world.lifecycle.log.warn('connections.provider_failed', message, {
    error: cause instanceof Error ? cause : String(cause),
  });

  return new ApplicationError(status, message);
}

export function webConnectionRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const { management, connections, documents, integrations, uploads, workouts, files, profiles } = runtime.services;
  const sessions = management.sessions;

  // Credentials the key cannot decrypt stay saved, so the rider is asked to enter them again.
  const saved = (player: number, name: z.infer<typeof provider>) => {
    const { credentials, unreadable } = connections.inspect(player, name);

    return { username: credentials?.[0] ?? '', saved: connections.has(player, name), unreadable };
  };

  app.get('/api/me/connections', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    return c.json({
      strava: {
        ...saved(player, 'strava'),
        authorized: documents.has(player, 'strava_token.txt'),
        cookie: documents.has(player, 'strava4_session.txt'),
      },
      garmin: {
        ...saved(player, 'garmin'),
        authorized: documents.has(player, 'garth/oauth1_token.json'),
      },
      intervals: saved(player, 'intervals'),
    });
  });
  app.put('/api/me/connections/:provider', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const name = provider.parse(c.req.param('provider'));
    const input = credentials.parse(await c.req.json());

    if (name === 'intervals') z.string().regex(/^\d+$/).parse(input.username);
    const secret = input.secret || connections.inspect(player, name).credentials?.[1];

    if (!secret) throw new ApplicationError(400, 'Enter a secret.');
    connections.save(player, name, [input.username, secret]);

    return c.json({ ok: true });
  });
  app.put('/api/me/connections/strava/cookie', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    const input = z
      .strictObject({
        cookie: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .regex(/^[^\r\n]+$/),
      })
      .parse(await c.req.json());

    documents.put(player, 'strava4_session.txt', input.cookie);

    return c.json({ ok: true });
  });
  // The Garmin device that the FIT file sent to Garmin Connect says it was recorded on.
  app.get('/api/me/connections/garmin/device', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    return c.json({
      device: parseDeviceIdentity(documents.text(player, 'garmin_device.txt') ?? ''),
      devices: GARMIN_DEVICES,
    });
  });
  app.put('/api/me/connections/garmin/device', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    const input = z
      .strictObject({
        product: z.number().int().min(1).max(65_535),
        serial: z.number().int().min(1).max(4_294_967_295).optional(),
      })
      .parse(await c.req.json());

    const current = parseDeviceIdentity(documents.text(player, 'garmin_device.txt') ?? '');
    documents.put(
      player,
      'garmin_device.txt',
      deviceText(input.product, input.serial ?? current?.serial ?? defaultSerial(player)),
    );

    return c.json({ ok: true });
  });
  app.delete('/api/me/connections/garmin/device', (c) => {
    documents.remove(sessions.require(c.get('sessionId')).player_id, 'garmin_device.txt');

    return c.json({ ok: true });
  });
  app.delete('/api/me/connections/:provider', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const name = provider.parse(c.req.param('provider'));
    connections.remove(player, name);

    if (name === 'strava') {
      uploads.disconnect(player, 'strava_token.txt');
      uploads.disconnect(player, 'strava4_session.txt');
    } else if (name === 'garmin') uploads.disconnect(player, 'garth/oauth1_token.json');

    return c.json({ ok: true });
  });
  // One stored credential, so a rider can drop the session cookie and keep the API, or the reverse.
  app.delete('/api/me/connections/:provider/:credential', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const name = credential.parse(`${c.req.param('provider')}/${c.req.param('credential')}`);

    if (name === 'strava/api') connections.remove(player, 'strava');
    else if (name === 'garmin/credentials') connections.remove(player, 'garmin');
    else uploads.disconnect(player, tokens[name]);

    return c.json({ ok: true });
  });
  app.post('/api/me/connections/garmin/authorize', async (c) => {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const identity = runtime.services.accounts.identityOf(user);
    const input = z.strictObject({ code: z.string().min(1).max(32).optional() }).parse(await c.req.json());

    try {
      const status = await integrations.authorizeGarminSession(
        `web:${id}`,
        () => sessions.current(id, identity),
        user,
        input.code,
      );

      return c.json({ status });
    } catch (error) {
      throw providerFailure(runtime, error, 400, 'Garmin authorization failed or expired. Try again.');
    }
  });
  app.post('/api/me/connections/strava/authorize', async (c) => {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const identity = runtime.services.accounts.identityOf(user);

    const input = z
      .strictObject({ code: z.string().min(1).max(2000).optional(), state: z.string().optional() })
      .parse(await c.req.json());

    if (input.code) {
      const session = sessions.find(id)!;

      if (!session.stravaState || input.state !== session.stravaState)
        throw new ApplicationError(403, 'Authorization expired.');
      delete session.stravaState;

      try {
        await integrations.authorizeStravaSession(() => sessions.current(id, identity), user, input.code);

        return c.json({ ok: true });
      } catch (error) {
        throw providerFailure(runtime, error, 400, 'Strava authorization failed. Try again.');
      }
    }

    const client = connections.read(user.player_id, 'strava');

    if (!client) throw new ApplicationError(400, 'Save Strava API credentials first.');
    const redirect = new URL('/integrations', runtime.config.network.web.publicUrl ?? c.req.url).href;
    const state = sessions.token();
    sessions.find(id)!.stravaState = state;

    return c.json({ url: integrations.authorizationUrl(client[0], state, redirect) });
  });
  app.post('/api/me/connections/strava/test', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const cookie = documents.text(player, 'strava4_session.txt')?.split(/\r?\n/, 1)[0];

    if (!cookie) throw new ApplicationError(400, 'Save a session cookie first.');

    try {
      return c.json({
        valid: await integrations.checkSession(cookie, (fresh) => documents.put(player, 'strava4_session.txt', fresh)),
      });
    } catch (error) {
      throw providerFailure(runtime, error, 503, 'Could not reach Strava. Check your internet connection.');
    }
  });
  app.post('/api/me/workouts/sync', async (c) => {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const identity = runtime.services.accounts.identityOf(user);

    const input = z.strictObject({ provider: z.enum(['intervals', 'trainingpeaks']) }).parse(await c.req.json());

    // The chosen provider becomes the one the game uses when both are configured.
    files.write(
      resolve(profiles.folder(user.player_id), 'active_workout_provider.txt'),
      workoutProviders[input.provider],
      true,
    );
    let message: string;

    try {
      message = await workouts.sync(user.player_id);
    } catch (error) {
      throw providerFailure(runtime, error, 503, 'Workout sync failed. Existing workouts were retained.');
    }

    if (!sessions.current(id, identity)) throw new ApplicationError(401, 'Session changed.');

    return c.json({ message });
  });
  app.get('/api/me/uploads', (c) =>
    c.json({ jobs: uploads.status(sessions.require(c.get('sessionId')).player_id).slice(0, 100) }),
  );
  const activityId = z.coerce.number().int().positive().safe();
  app.get('/api/me/activities/:id/uploads', (c) =>
    c.json({
      uploads: uploads.forActivity(sessions.require(c.get('sessionId')).player_id, activityId.parse(c.req.param('id'))),
    }),
  );
  app.post('/api/me/activities/:id/uploads', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const id = activityId.parse(c.req.param('id'));

    const input = z
      .strictObject({ provider: z.enum(UploadProvider), again: z.boolean().default(false) })
      .parse(await c.req.json());

    void uploads.request(player, id, input.provider, input.again);

    return c.json({ uploads: uploads.forActivity(player, id) });
  });
  app.post('/api/me/uploads/retry', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const input = z.strictObject({ ambiguous: z.boolean().default(false) }).parse(await c.req.json());
    void uploads.retry(player, input.ambiguous);

    return c.json({ ok: true });
  });
}
