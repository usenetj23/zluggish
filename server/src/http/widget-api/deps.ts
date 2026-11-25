import type { WidgetView } from '#src/http/widget-view';
import type { ChatMessage } from '#src/world/chat-log';
import type { WebEnv } from '#src/http/web-app';
import type { Context } from 'hono';

/** Everything the routes need from the outside world. */
export interface WidgetDeps {
  /** the athlete id of the signed-in rider of this request, or null when nobody is signed in. */
  viewer: (c: Context<WebEnv>) => number | null;

  /** whether the `Origin` header of this request belongs to this server. */
  originAllowed: (c: Context<WebEnv>) => boolean;

  /** whether the `Referer` header, when present, belongs to this server. */
  refererAllowed: (c: Context<WebEnv>) => boolean;

  /** The whole widget view of the viewer: the riders around it, as the viewer may see them. Every
  privacy decision of the view is made for the signed-in rider. */
  view: (viewerId: number) => WidgetView;

  /** delivers every chat message the viewer may see; the returned disposer stops the listener. */
  listenChat: (viewerId: number, listener: (message: ChatMessage) => void) => () => void;

  /** how often the push loop of the event socket repeats the live events. */
  pushIntervalMs: number;

  /** writes one verbose server log line; the logger takes JSON scalars only. */
  log: (event: string, message: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
}
