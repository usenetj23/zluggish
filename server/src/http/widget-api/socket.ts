import { t } from '#src/i18n/index';
import type { WidgetView } from '#src/http/widget-view';
import { athleteRecord } from '#src/http/widget-view';
import { frame } from '#src/http/widget-api/channels';
import type { ChannelFactory, EventChannel, Id, SocketScope } from '#src/http/widget-api/channels';
import { signIn } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import type { WebEnv } from '#src/http/web-app';
import { legacyRecord } from '#src/http/widget-records';
import { upgradeWebSocket } from '@hono/node-server';
import type { Context, Hono, Next } from 'hono';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import { Option, Schema } from 'effect';

/** How many event subscriptions one socket may hold at once. */
export const maxSubscriptions = 16;

/** How many event sockets one signed-in rider may have open at once. */
export const maxConnectionsPerRider = 32;

/** What the event socket itself needs from the outside world; each channel names its own deps. */
export type SocketDeps = Pick<
  WidgetDeps,
  'originAllowed' | 'viewer' | 'view' | 'listenChat' | 'log' | 'pushIntervalMs'
>;

/** The subscription frame the browser transport sends:
`{ type: 'request', uid, data: { method, arg: { event, subId } } }`. A widget that writes its own frames
leaves `uid` out, and `unsubscribe` addresses its subscription by `subId` alone. */
type Subscription = { method: 'subscribe' | 'unsubscribe'; uid: Id | undefined; event: string | undefined; subId: Id };

/** The `subId` a frame addresses a subscription by: a finite number as the client counts them up, or the
non-empty string a hand-written frame carries. Anything else names no subscription. */
const SubscriptionId = Schema.Union([Schema.Finite, Schema.String.check(Schema.isMinLength(1))]);

/** The `uid` of a request, kept in the type the sender used so the answer finds its handler there; a
missing or unusable uid means the sender waits for no answer at all. */
const decodeRequestId = Schema.decodeUnknownOption(Schema.Union([Schema.Finite, Schema.String]));

const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      uid: Schema.optional(Schema.Unknown),
      data: Schema.Struct({
        method: Schema.Literals(['subscribe', 'unsubscribe']),
        arg: Schema.Struct({ event: Schema.optional(Schema.Unknown), subId: SubscriptionId }),
      }),
    }),
  ),
);

/** A subscription frame, or null for anything that is not one: unknown and malformed frames are ignored. */
function subscription(message: WSMessageReceive): Subscription | null {
  if (typeof message !== 'string') {
    return null;
  }

  const frame = Option.getOrNull(decodeFrame(message));

  if (frame === null) {
    return null;
  }

  const { method, arg } = frame.data;
  const event = typeof arg.event === 'string' ? arg.event : undefined;

  // Only a subscription asks which event it wants; an unsubscribe names nothing but its `subId`.
  if (method === 'subscribe' && event === undefined) {
    return null;
  }

  return { method, uid: Option.getOrUndefined(decodeRequestId(frame.uid)), event, subId: arg.subId };
}

/** The athlete events a widget subscribes to: `athlete/self`, `athlete/watching` or `athlete/<id>`,
each of them optionally with the `/v2` suffix the newer widget pages use. */
const athleteEvent = /^athlete\/(self|watching|\d+)(\/v2)?$/;

/** The answer to a request that carried a `uid`: the client of the widget pages waits for it, and reads
`error` as a message when the request failed. A request with no `uid` waits for nothing, so `null` means
there is nothing to send back. */
function reply(uid: Id | undefined, ok: true | string): string | null {
  if (uid === undefined) {
    return null;
  }

  return ok === true
    ? JSON.stringify({ type: 'response', uid, success: true, data: null })
    : JSON.stringify({ type: 'response', uid, success: false, error: ok });
}

/** The acknowledgement of a subscription that named no `uid`: addressed by the `subId` the sender used,
so an accepted subscription is never left without any answer of its own. */
function addressedReply(subId: Id): string {
  return JSON.stringify({ type: 'response', uid: subId, success: true, data: null });
}

/** The event the Watching overlay pages use to follow the rider their overlay looks at: Sauce sends
it on a change of that rider and nothing else, and the payload is the athlete id alone. Zluggish
answers it for the viewer's own overlay, which looks at the viewer until it can be pointed elsewhere. */
const watchingAthleteEvent = 'watching-athlete-change';

/** What one view-backed event is worth at a given instant: `live: true` means the push loop repeats
it, and `null` means there is nothing to hand over at all, so no frame is sent. */
function snapshotFor(event: string, view: WidgetView): { data: unknown; live: boolean } | null {
  if (event === 'nearby') {
    // Without the `/v2` suffix the pages read `smooth` and `peaks` as objects keyed by period.
    return { data: view.nearby.map((record) => legacyRecord(record)), live: true };
  }

  if (event === 'nearby/v2') {
    return { data: view.nearby, live: true };
  }

  if (event === 'states') {
    // Sauce's `states` event (its `_formatState` of every nearby rider): the same neighbours as the
    // `nearby` event, reduced to their state plus the rider's id. The athlete info is deliberately
    // left out, so the privacy of this view is exactly the privacy of `nearby`.
    return { data: view.nearby.map((record) => ({ athleteId: record.athleteId, ...record.state })), live: true };
  }

  // Only the v2 group shape is known from Sauce's own pages, so both names carry the same records.
  if (event === 'groups' || event === 'groups/v2') {
    return { data: view.groups, live: true };
  }

  const athlete = athleteEvent.exec(event);

  if (athlete !== null) {
    const asked = athlete[1];
    const record = athleteRecord(view, asked === 'self' || asked === 'watching' ? asked : Number(asked));

    if (record === null) {
      return null;
    }

    // Group 2 of the pattern tells whether the event name carried the `/v2` suffix.
    return { data: athlete[2] === undefined ? legacyRecord(record) : record, live: true };
  }

  if (event === 'status') {
    return { data: { connected: true }, live: false };
  }

  if (event === 'overlay-windows-visibility') {
    // Zluggish has no overlay windows (an Electron feature), so the Overview page always hears
    // 'visible': it treats any other data as hidden and would grey its bar out. One answer, quiet.
    return { data: 'visible', live: false };
  }

  // Anything else keeps what it always gave: an acknowledged subscription with nothing to show.
  return { data: [], live: false };
}

/** Whether a view-backed event is repeated on a timer: the athlete events are, because the rider they
ask about can ride into range at any moment. */
function liveSnapshot(event: string): boolean {
  return (
    event === 'nearby' ||
    event === 'nearby/v2' ||
    event === 'states' ||
    event === 'groups' ||
    event === 'groups/v2' ||
    athleteEvent.test(event)
  );
}

/** The view-backed events (`nearby`, `groups`, `states`, `athlete/...`, `status`): one frame at
subscribe, and the live ones again on every pass. It answers every event no other channel takes. */
const snapshotChannel: ChannelFactory = (scope) => ({
  handles: () => true,
  quiet: () => false,
  polled: liveSnapshot,

  subscribe: (ws, subId, event) => {
    const payload = snapshotFor(event, scope.viewOf());

    if (payload !== null) {
      ws.send(frame(subId, payload.data));
    }
  },

  tick: (ws, subId, event, view) => {
    const payload = snapshotFor(event, view);

    if (payload !== null) {
      ws.send(frame(subId, payload.data));
    }
  },

  dispose: () => {
    // A view-backed subscription holds nothing of its own.
  },
});

/** `watching-athlete-change`: sent on a change of the rider the viewer's overlay looks at, never at
subscribe time. */
const watchingChannel: ChannelFactory = (scope) => {
  // The athlete id each subscription was last told about.
  const lastWatching = new Map<Id, number>();
  const lookedAt = (view: WidgetView) => view.self?.athleteId ?? scope.watching ?? 0;

  return {
    handles: (event) => event === watchingAthleteEvent,
    quiet: () => true,
    polled: () => true,

    subscribe: (_ws, subId) => {
      // What the overlay looks at at subscribe time is the baseline the push loop compares against.
      lastWatching.set(subId, lookedAt(scope.viewOf()));
    },

    tick: (ws, subId, _event, view) => {
      // The very id the view is built around, read the same way `getAthleteStreams` reads it. A
      // change between two passes of THIS subscription is the only frame.
      const now = lookedAt(view);

      if (lastWatching.get(subId) === now) {
        return;
      }

      lastWatching.set(subId, now);
      ws.send(frame(subId, now));
    },

    dispose: (subId) => {
      lastWatching.delete(subId);
    },
  };
};

/** `chat`: one frame per message of the chat log; the page reads its past from the `getChatHistory`
RPC, so nothing is sent at subscribe time. */
function chatChannel(deps: Pick<WidgetDeps, 'listenChat'>): ChannelFactory {
  return (scope) => {
    // The disposers of the chat listeners this socket registered, keyed by the raw `subId`.
    const disposers = new Map<Id, () => void>();

    const dispose = (subId: Id) => {
      const leave = disposers.get(subId);

      if (leave === undefined) {
        return;
      }

      disposers.delete(subId);
      leave();
    };

    return {
      handles: (event) => event === 'chat',
      quiet: () => true,
      polled: () => false,

      subscribe: (ws, subId) => {
        const { watching } = scope;

        if (watching === null) {
          return;
        }

        // A socket that died between messages must not throw out of the chat log: a failed send
        // gives its seat back.
        disposers.set(
          subId,
          deps.listenChat(watching, (message) => {
            // A chat frame can arrive long after its rider signed out, and the push loop may not
            // have ticked yet: a direct message never reaches a dead session's socket.
            if (scope.endIfSignedOut(ws)) {
              return;
            }

            try {
              ws.send(frame(subId, message));
            } catch {
              dispose(subId);
            }
          }),
        );
      },

      dispose,
    };
  };
}

/** A view of nothing, for the rare socket whose rider signed out between the guard and the upgrade. */
const emptyWidgetView: WidgetView = { nearby: [], groups: [], self: null, byId: new Map() };

/** The event WebSocket of the widget pages: `/api/ws/events`, its Origin and sign-in guard and the push
loop. `channels` adds event families of other parts of the API (streams, the game link); they are asked
before the built-in ones, and the view-backed channel answers whatever nobody else takes. */
export function mountEventSocket(
  app: Hono<WebEnv>,
  deps: SocketDeps,
  channels: ReadonlyArray<ChannelFactory> = [],
): void {
  // Event sockets a rider already has open, so one page reloading in a loop cannot pile them up.
  const open = new Map<number, number>();
  const factories = [...channels, watchingChannel, chatChannel(deps)];

  // The event socket is asked for by a browser: its Origin has to be this server's, and only a
  // signed-in rider has a neighbourhood to watch at all. Both checks run before the upgrade.
  app.use('/api/ws/events', async (c: Context<WebEnv>, next: Next) => {
    if (!deps.originAllowed(c)) {
      return c.json({ message: t('widget_origin_not_allowed') }, 403);
    }

    const viewer = deps.viewer(c);

    if (viewer === null) {
      return signIn(c);
    }

    if ((open.get(viewer) ?? 0) >= maxConnectionsPerRider) {
      return c.json({ message: t('widget_too_many_sockets') }, 429);
    }

    await next();
  });

  app.get(
    '/api/ws/events',
    upgradeWebSocket((c: Context<WebEnv>) => eventSocket(c, deps, factories, open)),
  );
}

/** One event socket: its subscriptions, its channels and its push loop. */
function eventSocket(
  c: Context<WebEnv>,
  deps: SocketDeps,
  factories: ReadonlyArray<ChannelFactory>,
  open: Map<number, number>,
) {
  // The guard established a signed-in rider, so exactly that one is watched here. Should it
  // nevertheless be gone by now, there simply is no neighbourhood to hand over.
  const watching = deps.viewer(c);
  // Keyed by the `subId` exactly as it arrived: a client counting its subscriptions up uses numbers,
  // and `1` as well as `'1'` has to keep answering the subscription it was handed.
  const subscriptions = new Map<Id, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;

  const stop = () => {
    if (timer === undefined) {
      return;
    }

    clearInterval(timer);
    timer = undefined;
  };

  /** Whether the rider of the upgrade is still the one the session names: a logout, a revoked session
  or a removed account must not leave this socket streaming. A viewer dep that throws counts as signed
  out. */
  const signedOut = () => {
    try {
      return deps.viewer(c) !== watching;
    } catch {
      return true;
    }
  };

  const scope: SocketScope = {
    watching,
    viewOf: () => (watching === null ? emptyWidgetView : deps.view(watching)),
    drop: (subId) => dispose(subId),
    endIfSignedOut: (ws) => {
      if (!signedOut()) {
        return false;
      }

      release();
      ws.close(1008, 'signed out');

      return true;
    },
  };
  // The view-backed channel answers whatever no other channel takes, so it is asked last.
  const fallback = snapshotChannel(scope);
  const all: ReadonlyArray<EventChannel> = [...factories.map((factory) => factory(scope)), fallback];
  const channelOf = (event: string): EventChannel => all.find((channel) => channel.handles(event)) ?? fallback;

  /** Gives back what one `subId` holds in every channel; calling it twice is harmless. */
  function dispose(subId: Id) {
    for (const channel of all) {
      channel.dispose(subId);
    }
  }

  // One rider has at most `maxConnectionsPerRider` sockets open at a time; the seat is handed back
  // exactly once, whichever of `close` and `error` the transport reports first.
  function release() {
    stop();

    // Every listener and cursor of this socket ends with it.
    for (const subId of subscriptions.keys()) {
      dispose(subId);
    }

    if (released || watching === null) {
      return;
    }

    released = true;

    const left = (open.get(watching) ?? 1) - 1;

    if (left <= 0) {
      open.delete(watching);
    } else {
      open.set(watching, left);
    }
  }

  /** The push loop: re-validates the session first, then one view per pass, then one pass per polled
  subscription. A broken view or a dead socket ends the loop here, so nothing keeps a closed connection
  or a failing world alive. */
  const tick = (ws: WSContext) => {
    if (ws.readyState !== 1) {
      stop();

      return;
    }

    // The upgrade's context still carries the session cookie, so the very same re-check the HTTP
    // RPCs run on every call runs here once per pass — outside the failure handler below, because
    // a signed-out rider is 1008, not a broken world (1011).
    if (scope.endIfSignedOut(ws)) {
      return;
    }

    try {
      const view = scope.viewOf();

      for (const [subId, event] of subscriptions) {
        const channel = channelOf(event);

        if (channel.polled(event)) {
          channel.tick?.(ws, subId, event, view);
        }
      }
    } catch (error) {
      deps.log('widget_api.failed', 'The widget push failed', { error: String(error) });
      stop();
      ws.close(1011, 'push failed');
    }
  };

  return {
    onOpen() {
      if (watching !== null) {
        open.set(watching, (open.get(watching) ?? 0) + 1);
      }
    },
    onMessage(evt: MessageEvent<WSMessageReceive>, ws: WSContext) {
      const request = subscription(evt.data);

      if (!request) {
        return;
      }

      if (request.method === 'unsubscribe') {
        // An unknown `subId` is not an error: the subscription it names is simply not held.
        subscriptions.delete(request.subId);
        dispose(request.subId);

        if (subscriptions.size === 0) {
          stop();
        }

        const answer = reply(request.uid, true);

        if (answer !== null) {
          ws.send(answer);
        }

        return;
      }

      const { subId } = request;
      const event = request.event ?? '';
      const channel = channelOf(event);

      /** The refusal every limit answers with: the same error reply, and nothing disposed. */
      const refuse = (reason: string) => {
        deps.log('widget_api.limit', reason, { event, subId });

        const refused = reply(request.uid, t('widget_too_many_subscriptions'));

        if (refused !== null) {
          ws.send(refused);
        }
      };

      // Re-asking for a `subId` replaces what it stood for and is not a second subscription.
      if (!subscriptions.has(subId) && subscriptions.size >= maxSubscriptions) {
        refuse('A widget hit the subscription limit');

        return;
      }

      // A NEW `subId` above the limit of its channel is refused; re-asking an existing `subId` stays
      // free, and `unsubscribe` frees the slot.
      if (
        channel.limit !== undefined &&
        !subscriptions.has(subId) &&
        subscriptions
          .values()
          .filter((held) => channelOf(held) === channel)
          .toArray().length >= channel.limit.max
      ) {
        refuse(channel.limit.reason);

        return;
      }

      // Re-asking for a `subId` replaces what it stood for entirely: a listener or a cursor of the old
      // subscription ends here, so one `subId` never answers with two of either.
      dispose(subId);
      subscriptions.set(subId, event);

      try {
        // The answer comes first: the widget client waits on it before it reads any pushed frame. A
        // subscription that sends no frame of its own and named no `uid` would otherwise hear nothing
        // back at all, so its acknowledgement goes out addressed by the `subId` the sender used.
        const answer = reply(request.uid, true) ?? (channel.quiet(event) ? addressedReply(subId) : null);

        if (answer !== null) {
          ws.send(answer);
        }

        channel.subscribe(ws, subId, event);
        deps.log('widget_api.subscribe', 'A widget subscribed to an event', { event, subId });

        if (channel.polled(event) && timer === undefined) {
          timer = setInterval(() => tick(ws), deps.pushIntervalMs);
        }
      } catch (error) {
        deps.log('widget_api.failed', 'The widget push failed', { error: String(error) });
        stop();
        ws.close(1011, 'push failed');
      }
    },
    onClose() {
      release();
    },
    onError() {
      release();
    },
  };
}
