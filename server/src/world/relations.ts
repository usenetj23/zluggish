/**
Who is near whom, in the convention of the Sauce for Zwift widget pages: gaps are seconds, negative
when the other rider is in front of the watched one. Plain arithmetic on rider packets, with no
access to the world, the protocol or the clock, so the same numbers can be checked in a test.
*/

/** One rider as seen in a single packet; the numbers are exactly what the protocol carries. */
export interface RiderPoint {
  id: number;

  /** course the rider is riding, the pair of start and finish that defines the lap. */
  course: number;

  /** road the rider is on; a course is a graph of roads joined at junctions. */
  road: number;

  /** whether the rider travels the road in its own direction. */
  forward: boolean;

  /** progress along the current road, in microseconds of road time. */
  roadTime: number;

  /** route the rider is following; 0 when the rider is not on a route. */
  route: number;

  /** metres ridden in this ride. */
  distance: number;

  /** world position in centimetres. */
  x: number;

  y: number;

  z: number;

  /** km/h. */
  speed: number;

  /** watts. */
  power: number;

  /** beats per minute; 0 when the rider wears no band. */
  heartrate: number;
}

/** One rider of the neighbourhood of the watched one, with the gap to it. */
export interface NearbyEntry {
  id: number;

  /** whether this entry is the watched rider itself. */
  self: boolean;

  /** seconds; negative when the rider is in front of the watched one. */
  gap: number;

  /** metres; negative when the rider is in front of the watched one. */
  gapDistance: number;

  /** whether the gap was estimated from a distance and a speed rather than from a race clock. */
  isGapEst: boolean;

  power: number;

  speed: number;

  heartrate: number;
}

/** A stretch of the neighbourhood that rides together, as the `groups/v2` record shows it. */
export interface RiderGroup {
  /** the smallest id of its members, which is how the widget pages name a group. */
  id: number;

  /** whether the watched rider rides in this group. */
  watching: boolean;

  /** members ordered by `gap`, the one in front first. */
  members: ReadonlyArray<NearbyEntry>;

  /** seconds to the watched rider; 0 for its own group. */
  gap: number;

  /** seconds from the last member of this group to the first member of the next one. */
  innerGap: number;

  isGapEst: boolean;

  power: number;

  speed: number;

  heartrate: number;

  /** watts saved in the slipstream. */
  draft: number;
}

/** Riders further apart than this are not part of the neighbourhood at all. */
export const maxGapSeconds = 900;

/** A larger gap than this between two neighbours means the pack is broken between them. */
export const groupBreakSeconds = 2;

/** Below this speed a stationary or crawling rider would make every gap explode, so gaps to riders
far ahead or behind are estimated with at least this much speed. */
export const minEstimateSpeed = 10;

/** Riders are ordered from the one in front of the watched rider to the one behind it. */
const byGap = (left: NearbyEntry, right: NearbyEntry): number =>
  left.gap === right.gap ? left.id - right.id : left.gap - right.gap;

const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** The middle value, or the average of the two middle ones for an even number of members. */
const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
Where the peer rides relative to the watched rider, in metres, or nothing when the two cannot be
compared at all. Two riders on the same road and in the same direction are compared by their place
on that road and measured along the ground; riders that are not are compared by how far they have
ridden on a shared route, which is all the packet says about them there.
*/
export function relate(watching: RiderPoint, peer: RiderPoint): { ahead: boolean; distance: number } | null {
  if (peer.course !== watching.course) {
    return null;
  }

  if (peer.road === watching.road && peer.forward === watching.forward) {
    const delta = peer.roadTime - watching.roadTime;
    const ahead = (watching.forward ? delta : -delta) > 0;
    const distance = Math.hypot(peer.x - watching.x, peer.y - watching.y, peer.z - watching.z) / 100;

    return { ahead, distance };
  }

  if (watching.route !== 0 && peer.route === watching.route) {
    const delta = peer.distance - watching.distance;

    return { ahead: delta > 0, distance: Math.abs(delta) };
  }

  return null;
}

/**
The neighbourhood of the watched rider, itself included, ordered from the rider in front to the one
behind. Only the watched rider is timed: every other gap is a distance divided by the speed of the
watched rider, which is the best estimate the packets allow, so it is marked as one.
*/
export function nearby(watching: RiderPoint, others: ReadonlyArray<RiderPoint>): Array<NearbyEntry> {
  const velocity = Math.max(minEstimateSpeed, watching.speed) / 3.6;

  const entries: Array<NearbyEntry> = [];

  for (const other of others) {
    if (other.id === watching.id) {
      continue;
    }

    const relation = relate(watching, other);

    if (relation === null) {
      continue;
    }

    const gapDistance = relation.ahead ? -relation.distance : relation.distance;
    const gap = gapDistance / velocity;

    if (Math.abs(gap) > maxGapSeconds) {
      continue;
    }

    entries.push({
      id: other.id,
      self: false,
      gap,
      gapDistance,
      isGapEst: true,
      power: other.power,
      speed: other.speed,
      heartrate: other.heartrate,
    });
  }

  entries.push({
    id: watching.id,
    self: true,
    gap: 0,
    gapDistance: 0,
    isGapEst: false,
    power: watching.power,
    speed: watching.speed,
    heartrate: watching.heartrate,
  });

  return entries.sort(byGap);
}

/**
The neighbourhood cut into packs that ride together. Riders stay in one pack as long as their gaps
are within `groupBreakSeconds` of each other, so a group is a run of neighbours and not a distance:
a fast group and a slow one split on the first gap nobody can close.

The gap of a group is measured to the member closest to the watched rider, which is the last member
of a group in front and the first member of a group behind it. `draft` stays 0 because drafting is
not reported anywhere in the protocol, see `DraftSnapshot` in `live-stats.ts`.
*/
export function groupRiders(entries: ReadonlyArray<NearbyEntry>): Array<RiderGroup> {
  const ordered = [...entries].sort(byGap);

  const packs: Array<Array<NearbyEntry>> = [];
  let pack: Array<NearbyEntry> = [];
  let previous: number | null = null;

  for (const entry of ordered) {
    if (previous !== null && entry.gap - previous > groupBreakSeconds) {
      packs.push(pack);
      pack = [];
    }

    pack.push(entry);
    previous = entry.gap;
  }

  if (pack.length > 0) {
    packs.push(pack);
  }

  const watched = packs.findIndex((members) => members.some((member) => member.self));

  return packs.map((members, index): RiderGroup => {
    const front = members[0] ?? { gap: 0, isGapEst: false };
    const back = members.at(-1) ?? front;
    const own = index === watched;
    const edge = own ? null : index < watched ? back : front;
    const next = packs[index + 1];
    const hearts = members.filter((member) => member.heartrate > 0).map((member) => member.heartrate);

    return {
      id: Math.min(...members.map((member) => member.id)),
      watching: own,
      members,
      gap: edge === null ? 0 : edge.gap,
      innerGap: next === undefined ? 0 : (next[0]?.gap ?? 0) - back.gap,
      isGapEst: edge?.isGapEst ?? false,
      power: mean(members.map((member) => member.power)),
      speed: median(members.map((member) => member.speed)),
      heartrate: hearts.length === 0 ? 0 : mean(hearts),
      draft: 0,
    };
  });
}
