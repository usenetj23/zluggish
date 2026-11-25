/**
How many Ride Ons each rider has been sent, counted where they are really handed to a recipient (the
`World.enqueue` queue). In memory only, bounded: at most `maxTrackedRiders` riders are remembered and
the least recently added one is dropped when the bound is reached, so a long-running world cannot grow
the counter without end. The Sauce athlete record shows the count in `state.rideons`.
*/

/** At most this many riders keep a count; the oldest insertion is dropped when a new one arrives. */
const maxTrackedRiders = 5000;

export class RideOnCounter {
  // Insertion order of a Map is exactly what "oldest dropped" wants: the first key is the oldest.
  private readonly counts = new Map<number, number>();

  /** Credit `n` Ride Ons to rider `to`; nothing happens for a non-finite id or a non-positive amount. */
  add(to: number, n = 1): void {
    if (!Number.isFinite(to) || !Number.isFinite(n)) {
      return;
    }

    const amount = Math.trunc(n);

    if (amount <= 0) {
      return;
    }

    const id = Math.trunc(to);

    if (!this.counts.has(id) && this.counts.size >= maxTrackedRiders) {
      const oldest = this.counts.keys().next();

      if (!oldest.done) {
        this.counts.delete(oldest.value);
      }
    }

    this.counts.set(id, (this.counts.get(id) ?? 0) + amount);
  }

  /** The count of rider `id`; 0 for a rider nobody has Ride-Oned (or one already dropped). */
  count(id: number): number {
    return this.counts.get(Math.trunc(id)) ?? 0;
  }

  /** Forget the count of rider `id`. */
  reset(id: number): void {
    this.counts.delete(Math.trunc(id));
  }
}
