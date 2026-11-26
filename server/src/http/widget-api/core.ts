import { t } from '#src/i18n/index';
import { rpcError, value } from '#src/http/widget-api/rpc';
import type { RpcHandlers } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import { builtinWindows } from '#src/world/window-manifests';

/** The calls every widget page makes that need nothing from the world: the app version, the refused
`getJSON` proxy, the empty follower list and the windows the Overlay offers. */
export function coreRpcs(deps: Pick<WidgetDeps, 'mods'>): RpcHandlers {
  return {
    getFollowerAthletes: ({ c }) => {
      // Zluggish has no follower relation: nobody follows a viewer, so the page gets an empty list
      // without a read of the world.
      return c.json(value([]));
    },

    getWebWindowManifests: ({ c }) => {
      // The windows the Overlay page of the web app lists, the built-in ones first and then the windows
      // of the enabled mods: the same for every rider.
      return c.json(value([...builtinWindows(), ...deps.mods.windowManifests()]));
    },

    getVersion: ({ c }) => {
      // The app version the mod compares feature gates against; 'zluggish' matches no Zwift version,
      // so a version-gated feature simply stays off instead of taking a wrong number for a real one.
      return c.json(value('zluggish'));
    },

    getJSON: ({ c }) => {
      // `getJSON` fetches whatever URL the page names, and answering it would turn this server into a
      // proxy for the page, so it stays refused on purpose. A signed-in rider still gets the refusal as
      // an RPC error of its own (a plain not-implemented would read as a missing feature the server
      // could grow), and it is a read: GET and POST both reach it, the 401 of the anonymous rider is
      // the RPC guard of every call here. The argument is not looked at: there is nothing to validate
      // for a call that never runs.
      return c.json({ success: false, error: rpcError('NotSupportedError', t('widget_get_json_unavailable')) }, 501);
    },
  };
}
