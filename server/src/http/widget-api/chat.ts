import { value } from '#src/http/widget-api/rpc';
import type { RpcHandlers } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';

/** The chat reads of the widget API: the past of the chat log, which the Chat page loads once before it
listens to the `chat` event of the socket. */
export function chatRpcs(deps: Pick<WidgetDeps, 'chatHistory'>): RpcHandlers {
  return {
    getChatHistory: ({ c, viewer }) => {
      // Only the messages the viewer may read (public ones and its own direct messages); a read
      // mutates nothing, so it needs no cross-site check.
      return c.json(value(deps.chatHistory(viewer)));
    },
  };
}
