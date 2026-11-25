/**
The W' balance of a ride: the Skiba differential model, with the rider's FTP used as critical power.
One second at a time: above critical power the balance drains by exactly the surplus, below it the
balance recovers in proportion to how much of the capacity is still unused. The balance starts full
and is capped at the capacity, but it is never clamped from below: a rider who digs deep shows a
negative balance, the same way Intervals.icu draws it.

The model remembers every second of the ride instead of only its running balance, because the FTP
(the critical power) can be edited mid-ride and the balance must then be recomputed from second zero
with the new value.
*/

/** Joules of anaerobic work capacity assumed when a rider has none of their own. */
export const defaultWPrime = 20_000;

/**
One second of the model. `balance` is the joules left before this second, `power` the watts of the
second, `cp` the critical power in watts (the FTP) and `wPrime` the capacity in joules. Above `cp` the
second costs exactly its surplus; below `cp` it pays back at a rate proportional to the empty part of
the capacity. The result is capped at `wPrime` and may go negative.
*/
export function wPrimeStep(balance: number, power: number, cp: number, wPrime: number): number {
  const next = power > cp ? balance - (power - cp) : balance + ((cp - power) * (wPrime - balance)) / wPrime;

  return Math.min(next, wPrime);
}

/** A missing, negative or otherwise unusable reading counts as zero (the same rule live-stats uses). */
const readable = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);

type Cache = { cp: number; wPrime: number; balance: number; applied: number };

/**
The W' balance of one ride, fed one power reading per second. Every second is remembered (a 12 hour
ride is 43,200 numbers, trivially small next to the windows the other metrics keep), so `value` can
be asked with a different cp later and still be right: with an unchanged cp only the seconds pushed
since the last answer are applied, otherwise the ride is replayed from second zero.
*/
export class WPrimeBalance {
  private readonly powers: Array<number> = [];

  private cache: Cache | null = null;

  /** Appends the next second of the ride; an unreadable wattage counts as zero. */
  push(power: number) {
    this.powers.push(readable(power));
  }

  /**
  The balance after every pushed second, or null when `cp` or `wPrime` is not a finite number above
  zero. Repeated calls with the same parameters only apply the seconds pushed since the last one.
  */
  value(cp: number, wPrime: number): number | null {
    if (!Number.isFinite(cp) || cp <= 0 || !Number.isFinite(wPrime) || wPrime <= 0) {
      return null;
    }

    let cache = this.cache;

    if (cache === null || cache.cp !== cp || cache.wPrime !== wPrime) {
      cache = { cp, wPrime, balance: wPrime, applied: 0 };
      this.cache = cache;
    }

    for (; cache.applied < this.powers.length; cache.applied += 1) {
      cache.balance = wPrimeStep(cache.balance, this.powers[cache.applied] ?? 0, cp, wPrime);
    }

    return cache.balance;
  }

  /** Forgets the ride; the next `value` of a full capacity is `wPrime` again. */
  reset() {
    this.powers.length = 0;
    this.cache = null;
  }

  /** The number of seconds pushed so far. */
  get length(): number {
    return this.powers.length;
  }
}
