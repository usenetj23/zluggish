import type { LapSpan, StatsSample, StatsSnapshot } from '#src/world/live-stats';
import { RiderStats } from '#src/world/live-stats';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';

/**
The ride statistics of every rider the world has seen since their last login. The world forwards each
received `PlayerState` here; a screen asks for a `snapshot` by player id.
*/
export class RideStats {
  private readonly riders = new Map<bigint, RiderStats>();

  /**
  Feeds one protocol packet to the rider's statistics, starting them on the first packet. `draft` is
  the estimated watts saved in the slipstream, 0 when unknown.
  */
  receive(playerId: bigint, state: PlayerState, draft = 0) {
    const stats = this.riders.get(playerId) ?? new RiderStats();

    this.riders.set(playerId, stats);
    stats.push(this.sample(state, draft));
    this.checkAutoLap(playerId, stats, state);
  }

  /**
  Sets (or with null, stops) the automatic lap: a new lap every `interval` metres of the packet's distance or
  seconds of its ride time, whatever the metric says. The marks of the riders are forgotten on every change.
  */
  configureAutoLap(config: { metric: 'distance' | 'time'; interval: number } | null) {
    this.autoLap = config;
    this.lapMarks.clear();
  }

  private autoLap: { metric: 'distance' | 'time'; interval: number } | null = null;

  /** Where in distance or time each rider's running automatic lap started. */
  private readonly lapMarks = new Map<bigint, number>();

  private checkAutoLap(playerId: bigint, stats: RiderStats, state: PlayerState) {
    if (this.autoLap === null) {
      return;
    }

    const mark = this.autoLap.metric === 'distance' ? state.distance : state.time;
    const started = this.lapMarks.get(playerId);

    // A distance or time that went backwards is a new ride: measure from there.
    if (started === undefined || mark < started) {
      this.lapMarks.set(playerId, mark);
    } else if (mark - started >= this.autoLap.interval) {
      this.lapMarks.set(playerId, mark);
      stats.startLap();
    }
  }

  /** Everything a screen needs about one rider; undefined when that rider never sent a packet. */
  snapshot(playerId: bigint, ftp: number): StatsSnapshot | undefined {
    return this.riders.get(playerId)?.snapshot(ftp);
  }

  /** Ends the current lap of one rider; a rider we never saw has no lap to end. */
  startLap(playerId: bigint) {
    this.riders.get(playerId)?.startLap();
  }

  /** Where each lap of one rider began and ended; a rider we never saw has no laps. */
  lapSpans(playerId: bigint): Array<LapSpan> {
    return this.riders.get(playerId)?.lapSpans() ?? [];
  }

  /** Forgets the ride of one rider, keeping the rider so the next packet starts a fresh ride. */
  reset(playerId: bigint) {
    this.riders.get(playerId)?.reset();
  }

  /** Drops the rider completely, down to the recorded laps; the next login starts from zero. */
  forget(playerId: bigint) {
    this.riders.delete(playerId);
    this.lapMarks.delete(playerId);
  }

  has(playerId: bigint) {
    return this.riders.has(playerId);
  }

  /** A packet is one sample; the protocol units are converted to the units of the snapshots. */
  private sample(state: PlayerState, draft: number): StatsSample {
    return {
      time: Number(state.worldTime),
      power: state.power,
      heartrate: state.heartrate,
      speed: state.speed / 1_000_000,
      cadence: (state.cadenceUHz * 60) / 1_000_000,
      draft,
      distance: state.distance,
      yAltitude: state.yAltitude,
    };
  }
}
