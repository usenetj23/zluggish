/**
One chat message of the game, as the world saw it. `to` is 0 for a public message and a player id
for a direct message; `team` and `muted` mirror the game's chat panel and are unused for now.
*/
export interface ChatMessage {
  from: number;
  to: number;
  message: string;
  ts: number;
  firstName: string;
  lastName: string;
  avatar: string;
  team: null;
  muted: boolean;
}

/**
The chat log of the world: every text message, the oldest ones dropped beyond `capacity`. A direct
message is visible only to its sender and its recipient, a public one to every viewer.
*/
export class ChatLog {
  private readonly messages: Array<ChatMessage> = [];

  private readonly listeners = new Map<number, Set<(message: ChatMessage) => void>>();

  constructor(
    readonly capacity = 200,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {}

  /** Keeps a copy of `message` and notifies every listener allowed to see it. */
  record(message: ChatMessage): void {
    const stored = { ...message };

    this.messages.push(stored);

    if (this.messages.length > this.capacity) {
      this.messages.shift();
    }

    // A snapshot of each set, so a listener that disposes itself during the call is safe.
    for (const [viewer, listeners] of this.listeners) {
      if (!ChatLog.visible(stored, viewer)) {
        continue;
      }

      for (const listener of listeners) {
        try {
          listener({ ...stored });
        } catch (error) {
          this.onListenerError(error);
        }
      }
    }
  }

  /** The messages `viewer` may read, newest first, at most `limit`, each a copy. */
  history(viewer: number, limit = 100): Array<ChatMessage> {
    const visible = this.messages.filter((message) => ChatLog.visible(message, viewer));

    return visible
      .slice(Math.max(0, visible.length - limit))
      .toReversed()
      .map((message) => ({ ...message }));
  }

  /**
  Delivers every message `viewer` is allowed to see. The returned disposer removes the listener;
  calling it twice is harmless.
  */
  listen(viewer: number, listener: (message: ChatMessage) => void): () => void {
    const listeners = this.listeners.get(viewer) ?? new Set();

    this.listeners.set(viewer, listeners);
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  /** A `to` of 0 is public; anything else is a direct message between `from` and `to`. */
  private static visible(message: ChatMessage, viewer: number) {
    return message.to === 0 || message.from === viewer || message.to === viewer;
  }
}
