import { z } from 'zod';

/**
The Overlay: live widget pages (`/pages/...`) the rider opens in their own browser windows, for a
second screen or an OBS-less setup. The windows come from the widget RPC `getWebWindowManifests`
(see `world/window-manifests.ts` on the server).
*/
export const webWindowSchema = z.object({
  /** Stable id, also the name of the popup window ('watching', 'power', ...). */
  type: z.string(),
  /** Page to open, a path of this server ('/pages/watching.html?windowType=watching'). */
  file: z.string(),
  prettyName: z.string(),
  prettyDesc: z.string().optional(),
  groupTitle: z.string().optional(),
  /** Set on the windows of a mod (see `windowManifests` of `mods-registry.ts` on the server). */
  mod: z.boolean().optional(),
  modId: z.string().optional(),
  query: z.record(z.string(), z.string()).optional(),
  options: z.object({ width: z.number().optional(), height: z.number().optional() }).optional(),
  /** Present when the window has its own settings page. */
  settingsFile: z.string().optional(),
});

export type WebWindow = z.infer<typeof webWindowSchema>;

export const webWindowsResponse = z.object({
  success: z.boolean(),
  value: z.array(webWindowSchema).optional(),
  error: z.object({ name: z.string(), message: z.string().optional(), stack: z.string().optional() }).optional(),
});

export const overlayStatus = z.object({ enabled: z.boolean() });

export type OverlayStatus = z.infer<typeof overlayStatus>;

/** A manifest's page path: a full path, or a file name under /pages/. */
export function pageUrl(file: string, query?: Record<string, string>): string {
  const base = file.startsWith('/') ? file : `/pages/${file}`;
  const parameters = query ? new URLSearchParams(query).toString() : '';

  if (!parameters) {
    return base;
  }

  return base.includes('?') ? `${base}&${parameters}` : `${base}?${parameters}`;
}

export const windowUrl = (window: WebWindow): string => pageUrl(window.file, window.query);

export const settingsUrl = (window: WebWindow): string => pageUrl(window.settingsFile ?? window.file);

/** `window.open`'s third argument: always a popup, sized when the manifest says how. */
export function popupFeatures(window: WebWindow): string {
  const parts = ['popup'];

  if (window.options?.width) {
    parts.push(`width=${window.options.width}`);
  }

  if (window.options?.height) {
    parts.push(`height=${window.options.height}`);
  }

  return parts.join(',');
}

export type WindowGroups = { builtin: Array<WebWindow>; mods: Array<WebWindow> };

/** Mod windows apart from the built-ins, so the page can head them 'From mods'. */
export function groupWindows(windows: Array<WebWindow>): WindowGroups {
  const isMod = (window: WebWindow) => window.mod === true || window.modId !== undefined;

  return { builtin: windows.filter((window) => !isMod(window)), mods: windows.filter(isMod) };
}
