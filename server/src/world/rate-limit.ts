/**
A sliding-window flood guard: `allow` lets a rider take `limit` actions per `windowMs` and refuses the
rest. A refused attempt is not recorded, so hammering the button does not push the window further away.
Riders with no timestamps left are dropped from the map, so it does not grow without bound. The clock is
injected so a test can move time.
*/
export class RateLimit {
  private readonly sent = new Map<number, Array<number>>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The number of riders still tracked. */
  public get size(): number {
    return this.sent.size;
  }

  /** Whether the rider may send now; records the action when allowed, refuses without recording otherwise. */
  public allow(riderId: number): boolean {
    const now = this.now();

    // Sweep every tracked rider, not just the one being asked about, so entries whose window has
    // expired cannot linger. The sweep is O(riders) per call, which is fine: riders who acted in
    // the last window are few.
    for (const [tracked, trackedStamps] of this.sent) {
      const fresh = trackedStamps.filter((stamp) => now - stamp < this.windowMs);

      if (fresh.length === 0) {
        this.sent.delete(tracked);
      } else {
        this.sent.set(tracked, fresh);
      }
    }

    const stamps = this.sent.get(riderId) ?? [];

    if (stamps.length === 0) {
      this.sent.delete(riderId);
    } else {
      this.sent.set(riderId, stamps);
    }

    if (stamps.length >= this.limit) {
      return false;
    }

    stamps.push(now);
    this.sent.set(riderId, stamps);

    return true;
  }
}
