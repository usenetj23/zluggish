import { t } from '#src/i18n/index';

/** One window the Overlay offers, in the shape the Sauce `getWebWindowManifests` RPC answers with. */
export interface WindowManifest {
  /** Stable id, also the name of the browser window it opens in. */
  readonly type: string;
  /** The page to open, a path of this server. */
  readonly file: string;
  /** The settings page of the window, when it has one. */
  readonly settingsFile?: string;
  readonly prettyName: string;
  readonly prettyDesc: string;
}

/**
The Overlay windows this server serves out of the box: the Sauce pages under `/pages/` (see
`routes/widget-pages.ts`), named in the language of the server. The Overview window has no settings
page here, because the Sauce one is the admin panel of the Sauce application.
*/
export function builtinWindows(): ReadonlyArray<WindowManifest> {
  return [
    {
      type: 'overview',
      file: '/pages/overview.html',
      prettyName: t('overlay_window_overview_name'),
      prettyDesc: t('overlay_window_overview_description'),
    },
    {
      type: 'nearby',
      file: '/pages/nearby.html?windowType=nearby',
      settingsFile: '/pages/nearby-settings.html',
      prettyName: t('overlay_window_nearby_name'),
      prettyDesc: t('overlay_window_nearby_description'),
    },
    {
      type: 'groups',
      file: '/pages/groups.html',
      settingsFile: '/pages/groups-settings.html',
      prettyName: t('overlay_window_groups_name'),
      prettyDesc: t('overlay_window_groups_description'),
    },
    {
      type: 'watching',
      file: '/pages/watching.html?windowType=watching',
      settingsFile: '/pages/watching-settings.html',
      prettyName: t('overlay_window_watching_name'),
      prettyDesc: t('overlay_window_watching_description'),
    },
    {
      type: 'chat',
      file: '/pages/chat.html',
      settingsFile: '/pages/chat-settings.html',
      prettyName: t('overlay_window_chat_name'),
      prettyDesc: t('overlay_window_chat_description'),
    },
    {
      type: 'power',
      file: '/pages/gauges/power.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_power_name'),
      prettyDesc: t('overlay_window_power_description'),
    },
    {
      type: 'hr',
      file: '/pages/gauges/hr.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_hr_name'),
      prettyDesc: t('overlay_window_hr_description'),
    },
    {
      type: 'cadence',
      file: '/pages/gauges/cadence.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_cadence_name'),
      prettyDesc: t('overlay_window_cadence_description'),
    },
    {
      type: 'pace',
      file: '/pages/gauges/pace.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_pace_name'),
      prettyDesc: t('overlay_window_pace_description'),
    },
    {
      type: 'wbal',
      file: '/pages/gauges/wbal.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_wbal_name'),
      prettyDesc: t('overlay_window_wbal_description'),
    },
    {
      type: 'draft',
      file: '/pages/gauges/draft.html',
      settingsFile: '/pages/gauges/settings.html',
      prettyName: t('overlay_window_draft_name'),
      prettyDesc: t('overlay_window_draft_description'),
    },
  ];
}
