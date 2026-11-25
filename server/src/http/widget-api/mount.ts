import { t } from '#src/i18n/index';
import type { WidgetNearbyRecord } from '#src/dtos/widget-api.dto';
import type { WidgetView } from '#src/http/widget-view';
import { athleteRecord } from '#src/http/widget-view';
import { mountEventSocket } from '#src/http/widget-api/socket';
import type { ChannelFactory } from '#src/http/widget-api/channels';
import { powerZones } from '#src/world/power-zones';
import { chatRpcs } from '#src/http/widget-api/chat';
import { coreRpcs } from '#src/http/widget-api/core';
import type { WebEnv } from '#src/http/web-app';
import type { RpcHandlers, RpcCall } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import {
  handlerFor,
  isCrossSite,
  notImplemented,
  rpcError,
  signIn,
  value,
  watchedRider,
} from '#src/http/widget-api/rpc';
import type { Context, Hono, Next } from 'hono';
import { Option, Schema } from 'effect';

/**
The transport Sauce for Zwift widget pages and community mods already speak: a
WebSocket at `/api/ws/events` for event subscriptions, and `/api/rpc/v1/<name>`
or `/api/rpc/v2/<name>/<args>` for RPC calls, the arguments of a v2 call being base64url
JSON path segments.

Everything these endpoints reveal belongs to a signed-in rider: the watched rider is
always the one the request's own session belongs to, so an anonymous request is
turned away before a frame is upgraded or a world packet is read. The values
themselves come from `widgetView`, the same view a later push would send.

`mountWidgetApi` holds the behaviour and takes it all through `WidgetDeps`, so a
test can hand over a world of its own; `widgetApiRoutes` wires it to the runtime.
*/

/** The RPC names that change the world. They mutate on POST only (see `call`): a GET must never
mutate, because the `SameSite=Lax` session cookie rides along on a cross-site top-level navigation.
Every call of this part of the API only reads; the parts that write add their names here. */
const mutatingCalls: ReadonlySet<string> = new Set<string>();

const decodeArgument = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Arguments of a v2 call: every path segment after the method name is base64url JSON; a malformed one throws. */
function v2Arguments(rest: string) {
  return rest
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeArgument(Buffer.from(segment, 'base64url').toString('utf8')));
}

/** The arguments of a v2 call sit in the path after `/api/rpc/v2/<name>/`; Hono binds no parameter for them. */
function v2Rest(path: string, name: string): string {
  const prefix = `/api/rpc/v2/${name}/`;

  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

const decodeArguments = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

/** Arguments of a v1 call: a JSON array body; anything else, a malformed body included, is no argument. */
async function v1Arguments(c: Context<WebEnv>): Promise<Array<unknown>> {
  const body: unknown = await c.req.json().catch(() => null);

  return Option.match(decodeArguments(body), { onNone: () => [], onSome: (args) => [...args] });
}

/** `streams/<athlete>`: the per-second samples of a ride. This part of the server keeps no such
history, so a subscription is acknowledged and never answered, exactly like `getAthleteStreams` hands
over empty streams. The fallback of the socket would send `[]`, which the Watching chart reads as a
batch of samples and fails on. */
const quietStreams: ChannelFactory = () => ({
  handles: (event) => event.startsWith('streams/'),
  quiet: () => true,
  polled: () => false,
  subscribe: () => {},
  dispose: () => {},
});

/** The streams of the Watching line chart (`lineChartFields` of `watching.mjs`) and their time axis. */
const streamNames = ['time', 'power', 'hr', 'speed', 'cadence', 'draft', 'wbal'];

function answered(name: string, args: Array<unknown>, view: WidgetView) {
  switch (name) {
    case 'getAthleteStreams': {
      // This part of the server keeps no per-second history of a ride, so every stream is empty: the
      // Watching line chart reads one array per field and appends to it, so each is there, with no
      // sample in it. The analysis part answers it for real.
      return value(Object.fromEntries(streamNames.map((name) => [name, []])));
    }
    case 'getGameConnectionStatus': {
      return value({ connected: true });
    }
    case 'getNearbyData': {
      return value(view.nearby);
    }
    case 'getPowerZones': {
      // Argument 0 is the FTP, a number or a numeric string; anything else is handled as 1 inside.
      const raw = typeof args[0] === 'string' ? Number(args[0]) : args[0];
      // eslint-disable-next-line unicorn/prefer-global-number-constants -- oxlint's prefer-number-properties asks for Number.NaN
      const ftp = typeof raw === 'number' ? raw : Number.NaN;

      return value(powerZones(ftp));
    }
    case 'getGroupsData': {
      return value(view.groups);
    }
    case 'getAthleteData': {
      // The 2nd argument of the alpha.7 form (`{ refresh, required }`) is ignored: every piece of the
      // record is local and always handed over whole.
      return value(athleteRecord(view, watchedRider(args[0])));
    }
    case 'getAthlete': {
      // The chat page asks for one athlete to address a direct message to; an id nobody rides here
      // simply has no athlete. The alpha.7 option object, when given as the 2nd argument, is ignored
      // for the same reason as in `getAthleteData`.
      return value(athleteRecord(view, watchedRider(args[0]))?.athlete ?? null);
    }
    case 'getPlayerState': {
      // The Profile page polls this for the live state of one rider; the same visibility rule as
      // `getAthleteData`: only a rider the viewer's world view knows is answered, anybody else is
      // simply not in the game for this viewer.
      return value(athleteRecord(view, watchedRider(args[0]))?.state ?? null);
    }
    case 'getAthletesData': {
      const ids = Array.isArray(args[0]) ? args[0] : [];
      const records = ids.map((id) => athleteRecord(view, watchedRider(id)));

      return value(records.filter((record): record is WidgetNearbyRecord => record !== null));
    }
    case 'getAthletes': {
      const ids = Array.isArray(args[0]) ? args[0] : [];

      // Same length and order as the ids asked for, so a widget can read its own list back;
      // an id nobody rides here simply has no athlete.
      return value(ids.map((id) => athleteRecord(view, watchedRider(id))?.athlete ?? null));
    }
    case 'getEventSubgroup':
    case 'getEvent': {
      // zluggish knows no Sauce events: no event, no subgroup, nothing to describe.
      return value(null);
    }
    case 'getSentryConfig': {
      // zluggish never forwards error reports to Sauce, so `Common.enableSentry()` in the widget
      // pages is handed no configuration and is never initialised.
      return value(null);
    }
    case 'getOverlayWindowsVisibilityState': {
      // Zluggish has no overlay windows (an Electron feature): the Overview page treats any answer
      // other than 'visible' as hidden and would grey its bar out, so it always hears 'visible'.
      return value('visible');
    }
    default: {
      return null;
    }
  }
}

export function mountWidgetApi(app: Hono<WebEnv>, deps: WidgetDeps): void {
  // The RPCs answered by a handler of their own; any other name is answered from the view (see
  // `answered`) or refused as not implemented.
  const handlers: RpcHandlers = { ...coreRpcs(), ...chatRpcs(deps) };
  mountEventSocket(app, deps, [quietStreams]);

  app.use('/api/rpc/*', async (c: Context<WebEnv>, next: Next) => {
    if (deps.viewer(c) === null) {
      // The client reads `env.error` of any non-5xx answer and destructures it with `makeRPCError`,
      // so even the 401 of this guard goes out as the RPC error envelope, not as a bare message.
      return c.json({ success: false, error: rpcError('AuthenticationError', t('widget_sign_in_first')) }, 401);
    }

    await next();
  });

  // `async`, so a handler may await its deps; Hono accepts the returned promise.
  const call = async (c: Context<WebEnv>, name: string, args: Array<unknown>) => {
    // The guard above already established a rider: it is the only one these routes can reveal.
    const watching = deps.viewer(c);

    if (watching === null) {
      return signIn(c);
    }

    // The `crossSite` check the handlers below need: is this request from an outside page?
    const crossSite = () => isCrossSite(c, deps.originAllowed, deps.refererAllowed);

    if (mutatingCalls.has(name) && c.req.method !== 'POST') {
      // A state-changing call is never a GET: the app's session cookie is `SameSite=Lax`, so a
      // cross-site top-level navigation carries it and would otherwise fire the call. Only POST
      // mutates, and a GET of one of these names is answered without touching a dep.
      return c.json({ success: false, error: rpcError('MethodNotAllowedError', t('widget_post_only')) }, 405, {
        Allow: 'POST',
      });
    }

    const handler = handlerFor(handlers, name);

    if (handler) {
      return handler({ c, name, args, viewer: watching, crossSite } satisfies RpcCall);
    }

    const reply = answered(name, args, deps.view(watching));

    return c.json(reply ?? notImplemented(name));
  };

  app.get('/api/rpc/v2/:name/*', async (c) => {
    const name = c.req.param('name') ?? '';

    let args: Array<unknown>;

    try {
      args = v2Arguments(v2Rest(c.req.path, name));
    } catch {
      return c.json({ success: false, error: rpcError('ArgumentError', t('widget_bad_arguments')) }, 400);
    }

    return call(c, name, args);
  });

  app.post('/api/rpc/v1/:name', async (c) => {
    const name = c.req.param('name') ?? '';

    // A malformed body is not an error of its own: it simply carries no arguments.
    return call(c, name, await v1Arguments(c));
  });
}
