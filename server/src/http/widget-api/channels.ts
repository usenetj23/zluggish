import type { WidgetView } from '#src/http/widget-view';
import type { WSContext } from 'hono/ws';

/** What addresses a request or a subscription. The browser client in `assets/sauce/pages/src/common.mjs`
counts both up (`uidInc++`), so they are numbers there, and it looks its answers up by the very same
value: an id is therefore handed back in exactly the type it arrived in, since `1` and `'1'` are two
different keys of its map. */
export type Id = number | string;

/** What one socket offers the channels it serves. */
export interface SocketScope {
  /** The signed-in rider of the socket, or null when the rider was gone by the upgrade. */
  readonly watching: number | null;

  /** The view of the rider, read fresh on every call. */
  viewOf: () => WidgetView;

  /** Gives back everything one `subId` holds in every channel, after a send to a dead socket failed;
  the subscription itself stays registered, exactly as before the channels existed. */
  drop: (subId: Id) => void;

  /** Ends the socket with 1008 when its rider signed out since the upgrade; true when it did. Channels
  that push off a listener instead of the push loop call it before they deliver anything. */
  endIfSignedOut: (ws: WSContext) => boolean;
}

/** One family of subscription events of the event socket. A channel instance belongs to one socket. */
export interface EventChannel {
  /** Whether this channel answers subscriptions of `event`. */
  handles: (event: string) => boolean;

  /** At most `max` subscriptions of this channel per socket; a new `subId` above it is refused and
  logged with `reason`. Re-asking an existing `subId` is free. */
  readonly limit?: { max: number; reason: string };

  /** Whether a subscribe sends no frame of its own, so a request without a `uid` is acknowledged by
  its `subId` instead (see `addressedReply`). */
  quiet: (event: string) => boolean;

  /** Whether the push loop looks at this subscription on every pass. */
  polled: (event: string) => boolean;

  /** Called once the subscription is registered and acknowledged: sends its first frame, sets up its
  cursor or its listener. */
  subscribe: (ws: WSContext, subId: Id, event: string) => void;

  /** One pass of the push loop for one polled subscription; `view` is read once per pass. */
  tick?: (ws: WSContext, subId: Id, event: string, view: WidgetView) => void;

  /** Gives back what one `subId` holds in this channel; calling it twice is harmless. */
  dispose: (subId: Id) => void;
}

/** Builds the channel of one socket. */
export type ChannelFactory = (scope: SocketScope) => EventChannel;

/** The frame carrying one subscription's data, addressed by the `subId` the widget asked with, in the
very type it used: the browser client looks its callbacks up by that value. */
export function frame(subId: Id, data: unknown): string {
  return JSON.stringify({ success: true, type: 'event', uid: subId, data });
}
