import type { WidgetView } from '#src/http/widget-view';
import type { ChatMessage } from '#src/world/chat-log';
import type { WebEnv } from '#src/http/web-app';
import type { ModRegistry } from '#src/world/mods-registry';
import type { StoreMod, StoreRelease } from '#src/world/mod-store';
import type { AthleteData, AthleteDataValue } from '#src/world/athlete-data-store';
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

  /** the chat messages of the world the viewer is allowed to read, newest first. */
  chatHistory: (viewerId: number) => Array<ChatMessage>;

  /** The viewer's own mod settings, one JSON document per rider: `get` answers the stored value for
  `key`, or `undefined` when the rider never set it, and `set` stores one value under `key` and answers
  false when the document would grow past its size limit. */
  settings: {
    get: (viewerId: number, key: string) => AthleteDataValue | undefined;
    set: (viewerId: number, key: string, value: AthleteDataValue) => boolean;
  };

  /** The free-form object a mod keeps per athlete through `updateAthleteData` (its lap sets, its
  segment results), scoped to the viewer who wrote it: `update` shallow-merges `data` over the stored
  object (a null key deletes it) and answers the merged object. It raises `AthleteDataError` when the
  data is no plain object, names a forbidden key or would grow past the size limit. */
  athleteData: {
    update: (viewer: number, athleteId: number, data: unknown) => AthleteData;
  };

  /** The mod registry of this installation: the Overlay settings page lists it and an administrator
  enables, grants the internet permission to or removes one through it. */
  mods: ModRegistry;

  /** The Sauce mod store of `mod-store.ts`: `directory` lists what the store offers (its release
  `url` never leaves the process) and `download` fetches one release archive, size- and hash-checked,
  for `installMod`; `downloadGitHub` fetches the archive of a GitHub repository ref for
  `installModFromGitHub`. */
  modStore: {
    directory: () => Promise<Array<StoreMod>>;
    download: (storeId: string, version?: string) => Promise<{ mod: StoreMod; release: StoreRelease; archive: Buffer }>;
    downloadGitHub: (repo: string, ref?: string) => Promise<{ repo: string; ref: string; archive: Buffer }>;
  };

  /** Whether the signed-in viewer of this request is an administrator; the mod changes are refused
  for everybody else. */
  isAdministrator: (c: Context<WebEnv>) => boolean;

  /** how often the push loop of the event socket repeats the live events. */
  pushIntervalMs: number;

  /** writes one verbose server log line; the logger takes JSON scalars only. */
  log: (event: string, message: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
}
