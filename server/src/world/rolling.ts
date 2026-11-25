import { t } from '#src/i18n/index';
const npWindow = 30;

/**
The mean of the last `size` samples, kept in O(1) per pushed sample. Samples arrive at 1 Hz, so a
window of `size` samples covers the last `size` seconds. The sum is updated by adding the incoming
sample and subtracting the one that falls out, instead of re-reading the buffer.
*/
export class RollingWindow {
  private readonly samples: Float64Array;

  private next = 0;

  private held = 0;

  private sum = 0;

  constructor(readonly size: number) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new RangeError(t('rolling_window_size_invalid', { value1: size }));
    }

    this.samples = new Float64Array(size);
  }

  push(value: number) {
    if (this.held === this.size) {
      this.sum -= this.samples[this.next] ?? 0;
    } else {
      this.held += 1;
    }

    this.samples[this.next] = value;
    this.next = (this.next + 1) % this.size;
    this.sum += value;
  }

  get count(): number {
    return this.held;
  }

  get full(): boolean {
    return this.held === this.size;
  }

  get mean(): number {
    return this.held === 0 ? 0 : this.sum / this.held;
  }

  reset() {
    this.samples.fill(0);
    this.next = 0;
    this.held = 0;
    this.sum = 0;
  }
}

/**
The best average over any window of `period` consecutive samples, for example the strongest five
minutes of a ride. The record never falls back, so it survives a quiet finish.
*/
export class PeakTracker {
  private readonly window: RollingWindow;

  private best: number | null = null;

  constructor(readonly period: number) {
    this.window = new RollingWindow(period);
  }

  push(value: number) {
    this.window.push(value);

    if (this.window.full) {
      this.best = this.best === null ? this.window.mean : Math.max(this.best, this.window.mean);
    }
  }

  get peak(): number | null {
    return this.best;
  }

  get current(): number | null {
    return this.window.full ? this.window.mean : null;
  }

  reset() {
    this.window.reset();
    this.best = null;
  }
}

/**
Normalized Power: the mean of the fourth powers of a 30 second rolling average of power, taken over
the whole ride, brought back to watts by the fourth root. Only complete 30 second windows count.
*/
export class NormalizedPower {
  private readonly window = new RollingWindow(npWindow);

  private fourthPowers = 0;

  private counted = 0;

  push(power: number) {
    this.window.push(power);

    if (!this.window.full) {
      return;
    }

    this.fourthPowers += this.window.mean ** 4;
    this.counted += 1;
  }

  get value(): number {
    return this.counted === 0 ? 0 : (this.fourthPowers / this.counted) ** 0.25;
  }

  reset() {
    this.window.reset();
    this.fourthPowers = 0;
    this.counted = 0;
  }
}

/**
Normalized Power over the last `period` seconds only (not the whole ride): the fourth powers of the 30
second rolling average are averaged over a window of `period` of them. Null until that window is full.
Used for the efficiency factor (normalized power over heart rate) of the last five and twenty minutes.
*/
export class WindowedNormalizedPower {
  private readonly thirty = new RollingWindow(npWindow);

  private readonly fourthPowers: RollingWindow;

  constructor(readonly period: number) {
    this.fourthPowers = new RollingWindow(period);
  }

  push(power: number) {
    this.thirty.push(power);

    if (this.thirty.full) {
      this.fourthPowers.push(this.thirty.mean ** 4);
    }
  }

  get current(): number | null {
    return this.fourthPowers.full ? this.fourthPowers.mean ** 0.25 : null;
  }

  reset() {
    this.thirty.reset();
    this.fourthPowers.reset();
  }
}
