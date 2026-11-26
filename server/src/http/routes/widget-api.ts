import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';
import { mountWidgetApi } from '#src/http/widget-api/mount';
import { widgetView, withAthleteData } from '#src/http/widget-view';
import { DocumentsService } from '#src/services/documents.service';
import { ProfilesService } from '#src/services/profile.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { watchBotProfiles } from '#src/world/bot-profiles';
import { loadBikeFrameNames } from '#src/world/equipment';
import { AthleteDataStore } from '#src/world/athlete-data-store';
import type { AthleteData } from '#src/world/athlete-data-store';
import { ModStore } from '#src/world/mod-store';
import type { ModRegistry } from '#src/world/mods-registry';
import { fresh } from '#src/world/state';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { Option, Schema } from 'effect';

/** The whole settings document of one rider, serialized: a few kilobytes of mod settings at most, so
a page that keeps appending to one key is refused instead of growing the database without end. */
const maxSettingsBytes = 256 * 1024;

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

/** The widget API wired to the running server: its sessions, its profiles, its world and its mods. */
export function widgetApiRoutes(app: Hono<WebEnv>, runtime: HttpRuntime, mods: ModRegistry): void {
  const sessions = runtime.effects.runSync(WebSessionsService);
  const profiles = runtime.effects.runSync(ProfilesService);
  const documents = runtime.effects.runSync(DocumentsService);
  // What every mod keeps per athlete through `updateAthleteData`, in memory of this run only.
  const athleteData = new AthleteDataStore();
  /** The settings document of one rider; an unreadable or foreign document is an empty one, so a
  broken file never breaks a page. */
  const settingsOf = (viewerId: number): AthleteData => {
    const text = runtime.effects.runSync(documents.text(viewerId, 'overlay-settings.json'));

    return text === null ? {} : Option.getOrElse(decodeSettings(text), () => ({}));
  };
  // The bike frame names of the game info, loaded once: the athlete `equipment` of the Zwift 2.4 wire
  // shape resolves the profile's frame id through this map (see `world/equipment`).
  const frames = loadBikeFrameNames(runtime.assets);
  // The optional catalogue of bot rider facts, re-read when its file changes (see `world/bot-profiles`).
  const botProfiles = watchBotProfiles(join(runtime.config.storageDir, 'bot-profiles.json'));
  const world = runtime.world;
  const { publicUrl } = runtime.config.network.web;

  mountWidgetApi(app, {
    viewer: (c) => {
      const id = c.get('sessionId');

      if (!id) {
        return null;
      }

      try {
        // `sessions.require` raises a 401 ApplicationError for an unknown or ended session.
        return runtime.effects.runSync(sessions.require(id)).player_id;
      } catch {
        return null;
      }
    },

    // mirrors sameOrigin in web-app.ts, which is private there: a missing Origin means a
    // non-browser caller and is allowed, a present one has to be this server.
    originAllowed: (c) => {
      const origin = c.req.header('Origin');

      if (origin === undefined) {
        return true;
      }

      if (publicUrl) {
        return origin === publicUrl;
      }

      try {
        return new URL(origin).host === new URL(c.req.url).host;
      } catch {
        return false;
      }
    },

    // the same rule one header over: a missing Referer means a non-browser caller and is allowed,
    // a present one has to be this server; one that cannot be parsed counts as foreign.
    refererAllowed: (c) => {
      const referer = c.req.header('Referer');

      if (referer === undefined) {
        return true;
      }

      try {
        if (publicUrl) {
          return new URL(referer).origin === publicUrl;
        }

        return new URL(referer).host === new URL(c.req.url).host;
      } catch {
        return false;
      }
    },

    view: (viewerId) => {
      // What the viewer may see of a rider, never the stored profile itself: another rider's FTP and
      // weight are private, and a training stress score computed from a real FTP would give that FTP
      // back even when the FTP field itself is hidden, so statistics below are taken at FTP 0.
      const profile = (id: number) =>
        runtime.effects.runSync(profiles.forViewer(runtime.effects.runSync(profiles.get(id)), viewerId));
      const states = [...world.online.values().filter((state) => fresh(state)), ...world.synthetic.values()];

      const view = widgetView({
        watchingId: viewerId,
        states,
        stats: (id) => world.rideStats.snapshot(BigInt(id), profile(id).ftp),
        profile,
        botProfiles: botProfiles(),
        frames,
        rideOns: (id) => world.rideOns.count(id),
      });

      // The data the viewer's mods keep per athlete travels inside the athlete record.
      return withAthleteData(view, (athleteId) => athleteData.get(viewerId, athleteId));
    },

    listenChat: (viewerId, listener) => world.chat.listen(viewerId, listener),

    chatHistory: (viewerId) => world.chat.history(viewerId, 100),

    pushIntervalMs: 1000,

    // The settings of one rider live in the rider document `overlay-settings.json`, one flat JSON object.
    settings: {
      get: (viewerId, key) => settingsOf(viewerId)[key],
      set: (viewerId, key, setting) => {
        const serialized = JSON.stringify({ ...settingsOf(viewerId), [key]: setting });

        if (Buffer.byteLength(serialized, 'utf8') > maxSettingsBytes) {
          return false;
        }

        runtime.effects.runSync(documents.put(viewerId, 'overlay-settings.json', serialized));

        return true;
      },
    },

    // In memory for the whole life of this server: a restart empties it and nothing is written to disk.
    athleteData: {
      update: (viewer, athleteId, data) => athleteData.update(viewer, athleteId, data),
    },

    mods,

    // https to the allow-listed hosts only, size- and hash-checked (see `world/mod-store`).
    modStore: new ModStore(),

    // `sessions.require(id, true)` raises unless the session's user holds the administrator role.
    isAdministrator: (c) => {
      const id = c.get('sessionId');

      if (!id) {
        return false;
      }

      try {
        runtime.effects.runSync(sessions.require(id, true));

        return true;
      } catch {
        return false;
      }
    },

    log: (event, message, fields) => runtime.world.lifecycle.log.verbose(event, message, fields),
  });
}
