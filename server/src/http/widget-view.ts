/**
The whole Sauce view of one watched rider at a single instant: the `nearby` stream, the `groups/v2`
stream, the record of the watched rider itself and a lookup by athlete id. Pure like `widget-records`:
the caller hands over the rider packets it already holds and the two ways of asking about a rider, so
no world, socket or clock is touched here and a test can check the same numbers.
*/

import type { WidgetGroupRecord, WidgetNearbyRecord, OverlayRelation } from '#src/dtos/widget-api.dto';
import { groupRecord, nearbyRecord, riderPoint } from '#src/http/widget-records';
import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import type { StatsSnapshot } from '#src/world/live-stats';
import type { BotProfiles } from '#src/world/bot-profiles';
import { groupRiders, nearby } from '#src/world/relations';

/** What the view is built from: the watched rider, the packets of every known rider and how to ask
about one of them. Packets of riders that have gone stale are expected to be filtered out already. */
export interface ViewSource {
  /** id of the watched rider. */
  watchingId: number;

  /** states of every known rider, real and bot alike; stale ones already filtered out. */
  states: ReadonlyArray<PlayerState>;

  /** rolling ride statistics of a rider; `undefined` for a rider we do not track, a bot for instance. */
  stats: (id: number) => StatsSnapshot | undefined;

  /** profile of a rider, asked at most once per rider per view. */
  profile: (id: number) => PlayerProfile;

  /** the catalogue of bot rider facts (see `world/bot-profiles`); when absent, no athlete record of the
  view carries any bot facts. */
  botProfiles?: BotProfiles;

  /** the viewer's own stance towards the riders it follows, marks or mutes, by athlete id (see the
  `overlay_relation` table); when absent, no athlete record of the view carries any such flag. */
  relations?: ReadonlyMap<number, OverlayRelation>;

  /** the frame-name map of `world/equipment`; when absent, no athlete record of the view carries an
  `equipment` key. */
  frames?: ReadonlyMap<number, string>;

  /** the Ride Ons a rider has been sent (see `world/ride-on-count`), asked by athlete id; when absent,
  no record of the view reports any Ride On. */
  rideOns?: (id: number) => number;

  /** the distance ridden along the route of a rider (see `world/route-distance`); when absent, no state carries one. */
  routeProgress?: (id: number, state: PlayerState) => { routeDistance: number; routeEnd: number } | undefined;
}

/** Everything a page or a push needs to show one watched rider's neighbourhood. */
export interface WidgetView {
  /** the `nearby` stream, the rider in front first and the watched rider among them. */
  nearby: Array<WidgetNearbyRecord>;

  /** the `groups/v2` stream, in the same order as `nearby`. */
  groups: Array<WidgetGroupRecord>;

  /** the record of the watched rider, or nothing when it is not riding at all. */
  self: WidgetNearbyRecord | null;

  /** the same records, reachable by the athlete id they carry. */
  byId: ReadonlyMap<number, WidgetNearbyRecord>;
}

/**
The whole view. The watched rider's own record is part of `nearby`, exactly as the packets the widget
pages read say it, and `groups` cuts the very same entries into packs, so both streams agree.
*/
export function widgetView(source: ViewSource): WidgetView {
  const empty: WidgetView = { nearby: [], groups: [], self: null, byId: new Map() };

  const watchedState = source.states.find((state) => Number(state.id) === source.watchingId);

  if (watchedState === undefined) {
    return empty;
  }

  const points = source.states.map((state) => riderPoint(state));
  const watching = riderPoint(watchedState);
  const entries = nearby(watching, points);

  const stateById = new Map(source.states.map((state) => [Number(state.id), state]));

  // A profile is identity, not ride state: asked once per rider even when both streams want it.
  const profileById = new Map<number, PlayerProfile>();
  const profileOf = (id: number): PlayerProfile => {
    const known = profileById.get(id);

    if (known !== undefined) {
      return known;
    }

    const profile = source.profile(id);

    profileById.set(id, profile);

    return profile;
  };

  const records: Array<WidgetNearbyRecord> = [];

  for (const entry of entries) {
    const state = stateById.get(entry.id);

    if (state === undefined) {
      continue;
    }

    records.push(
      nearbyRecord(
        entry,
        state,
        source.stats(entry.id),
        profileOf(entry.id),
        undefined,
        source.botProfiles,
        source.relations?.get(entry.id),
        source.frames,
        0,
        source.rideOns?.(entry.id) ?? 0,
        source.routeProgress?.(entry.id, state),
      ),
    );
  }

  const byIdEarly = new Map(records.map((record) => [record.athleteId, record]));
  const groups = groupRiders(entries).map((group) =>
    groupRecord(group, source.stats, (id) => byIdEarly.get(id)?.athlete),
  );

  const self = records.find((record) => record.watching) ?? null;
  const byId = new Map(records.map((record) => [record.athleteId, record]));

  return { nearby: records, groups, self, byId };
}

/** The record of one rider: `'self'` and `'watching'` both mean the watched rider, a number is asked
of the view by athlete id and an unknown id is nothing at all. */
export function athleteRecord(view: WidgetView, id: number | 'self' | 'watching'): WidgetNearbyRecord | null {
  return typeof id === 'number' ? (view.byId.get(id) ?? null) : view.self;
}
