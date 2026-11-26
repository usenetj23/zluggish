import { t } from '#src/i18n/index';
import { rpcError, value, watchedRider } from '#src/http/widget-api/rpc';
import type { RpcCall, RpcHandlers } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import { AthleteDataError } from '#src/world/athlete-data-store';
import { RateLimit } from '#src/world/rate-limit';
import { Option, Schema } from 'effect';

type Status = 400 | 403 | 429 | 500;

function refuse(call: RpcCall, name: string, message: string, status: Status) {
  return call.c.json({ success: false, error: rpcError(name, message) }, status);
}

/** A setting key of a mod: a short name, not a path or a script. */
const settingsKey = /^[\w.:-]{1,100}$/;

function keyOf(argument: unknown): string | null {
  return typeof argument === 'string' && settingsKey.test(argument) ? argument : null;
}

/** A setting value is JSON; the transport already parsed it, so only a hand-written frame fails here. */
const decodeSetting = Schema.decodeUnknownOption(Schema.Json);

/**
The storage calls of the widget API: the settings a page or a mod keeps for the signed-in rider, and the
free-form `updateAthleteData` a mod keeps about another athlete. Both write only what belongs to the
viewer, so an outside page is refused, and each has a rate limit of its own.
*/
export function storageRpcs(deps: Pick<WidgetDeps, 'settings' | 'athleteData' | 'view' | 'log'>): RpcHandlers {
  // A mod saves a setting on every click of its options: sixty writes per rider per minute are plenty.
  const settingLimit = new RateLimit(60, 60_000);
  // A mod keeps its own athlete data alive through `updateAthleteData`, and it writes often (a lap set
  // per stroke is realistic): sixty writes per rider per ten seconds.
  const athleteDataLimit = new RateLimit(60, 10_000);

  /** The athlete of argument 0: 'self' or 'watching' for the rider the view is built around, otherwise
  a positive safe integer as a number or a numeric string. */
  const athleteOf = (call: RpcCall): number | null => {
    const asked = watchedRider(call.args[0]);

    if (asked === 'self' || asked === 'watching') {
      return deps.view(call.viewer).self?.athleteId ?? call.viewer;
    }

    return Number.isSafeInteger(asked) && asked > 0 ? asked : null;
  };

  return {
    getSetting: (call) => {
      const key = keyOf(call.args[0]);

      if (key === null) {
        return refuse(call, 'ArgumentError', t('widget_setting_key_required'), 400);
      }

      // Argument 1 is the default the page wants back when the rider never set the key; no argument at
      // all means no default, which is `null` on the wire.
      const stored = deps.settings.get(call.viewer, key);

      return call.c.json(value(stored === undefined ? (call.args[1] ?? null) : stored));
    },

    setSetting: (call) => {
      if (call.crossSite()) {
        return refuse(call, 'ForbiddenError', t('widget_cross_site_refused'), 403);
      }

      if (!settingLimit.allow(call.viewer)) {
        return refuse(call, 'RateLimitError', t('widget_setting_rate_limited'), 429);
      }

      const key = keyOf(call.args[0]);
      const setting = Option.getOrUndefined(decodeSetting(call.args[1] ?? null));

      if (key === null) {
        return refuse(call, 'ArgumentError', t('widget_setting_key_required'), 400);
      }

      if (setting === undefined) {
        return refuse(call, 'ArgumentError', t('widget_setting_not_json'), 400);
      }

      try {
        // The settings of one mod are a few kilobytes: a document past the limit is a page that keeps
        // appending to one key, and the rider hears about it as a refused write.
        return deps.settings.set(call.viewer, key, setting)
          ? call.c.json(value(null))
          : refuse(call, 'ArgumentError', t('widget_settings_too_large'), 400);
      } catch (error) {
        deps.log('widget_api.failed', 'Storing a setting failed', { error: String(error) });

        return refuse(call, 'InternalError', t('widget_setting_not_stored'), 500);
      }
    },

    // The page asks to persist what it kept in `sessionStorage`; every setting is written straight to the
    // rider document, so nothing is waiting to be flushed.
    flushSessionStorage: (call) => call.c.json(value(null)),

    updateAthleteData: (call) => {
      if (call.crossSite()) {
        return refuse(call, 'ForbiddenError', t('widget_cross_site_refused'), 403);
      }

      if (!athleteDataLimit.allow(call.viewer)) {
        return refuse(call, 'RateLimitError', t('widget_athlete_data_rate_limited'), 429);
      }

      const athleteId = athleteOf(call);
      const data = call.args[1];

      if (athleteId === null) {
        return refuse(call, 'ArgumentError', t('widget_athlete_id_required'), 400);
      }

      // A plain JSON object, not an array and not null; the store checks its size and its keys.
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return refuse(call, 'ArgumentError', t('widget_athlete_data_object'), 400);
      }

      try {
        return call.c.json(value(deps.athleteData.update(call.viewer, athleteId, data)));
      } catch (error) {
        if (error instanceof AthleteDataError) {
          return refuse(call, 'ArgumentError', error.detail, 400);
        }

        deps.log('widget_api.failed', 'Storing athlete data failed', { error: String(error) });

        return refuse(call, 'InternalError', t('widget_athlete_data_not_stored'), 500);
      }
    },
  };
}
