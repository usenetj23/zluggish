import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
Facts the Zwift client itself writes to its log about what is on screen:
the workout it started, the ERG targets driving the block display and the
ride ending. The voice reads these when the server never saw the plan,
like the workout library bundled in the game.
*/
export type ZwiftFact =
  | { kind: 'workout-start'; id: number; uuid: string }
  | { kind: 'erg'; from: number; to: number }
  | { kind: 'abandoned' }
  | { kind: 'free-ride' }
  | { kind: 'session-end' }
  | { kind: 'split'; n: number }
  | { kind: 'ride-end' };

const START = /\[GameState\] Starting Workout\. \{workoutID: (\d+), workoutUniqueID: "([^"]+)"\}/;
const ERG = /\[FTMS\] ERG (\d+)w --> (\d+)w/;
const ABANDONED = /WORKOUT_ABANDONED analytics/;
const FREE = /\[GameState\] Starting Free Ride\./;
const END = /\[GameState\] SendApplicationSessionEndEvent/;
const SPLIT = /\[Splits\] Cycling Split (\d+) started/;
const RIDE_END = /\[GameState\] Ending Ride\./;

/** One log line, or null when the line says nothing the rider should hear. */
export function parseLine(line: string): ZwiftFact | null {
  let m = START.exec(line);

  if (m) return { kind: 'workout-start', id: Number(m[1]), uuid: m[2] ?? '' };

  m = ERG.exec(line);

  if (m) return { kind: 'erg', from: Number(m[1]), to: Number(m[2]) };

  if (ABANDONED.test(line)) return { kind: 'abandoned' };

  if (FREE.test(line)) return { kind: 'free-ride' };

  if (END.test(line)) return { kind: 'session-end' };

  if (RIDE_END.test(line)) return { kind: 'ride-end' };

  m = SPLIT.exec(line);

  if (m) return { kind: 'split', n: Number(m[1]) };

  return null;
}

/** Complete lines of a growing text: a half line at the end waits for its rest. */
function lineSplitter(onLine: (line: string) => void) {
  let carry = '';

  return {
    feed(text: string) {
      const lines = (carry + text).split('\n');

      carry = lines.pop() ?? '';

      for (const line of lines) onLine(line);
    },
    reset() {
      carry = '';
    },
  };
}

/**
Follow the client log from its end, feeding every complete new line to the listener. Returns the function that stops
following: the runtime calls it when it closes, so no timer outlives it.
*/
export function tailZwiftLog(path: string, onLine: (line: string) => void) {
  // A fresh open each time: a cached stat keeps reporting the old size after
  // the client recreates its log, and the tail would then never move again.
  const sizeOf = () => {
    try {
      const descriptor = openSync(path, 'r');

      try {
        return fstatSync(descriptor).size;
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return -1; // no log yet
    }
  };

  let offset = sizeOf();

  if (offset < 0) offset = 0;

  const splitter = lineSplitter(onLine);

  const timer = setInterval(() => {
    // The client may recreate its log between two steps, and a listener may fail: a timer must never end the server.
    try {
      const size = sizeOf();

      if (size < 0) return;

      if (size < offset) {
        offset = 0; // the client started a new log
        splitter.reset();
      }

      if (size === offset) return;

      const buffer = Buffer.alloc(size - offset);
      const descriptor = openSync(path, 'r');

      try {
        readSync(descriptor, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(descriptor);
      }

      offset = size;
      splitter.feed(buffer.toString());
    } catch {
      // The next tick looks again.
    }
  }, 700);

  timer.unref();

  return () => clearInterval(timer);
}

/**
Follow the client log through the helper that runs on the Mac (scripts/say-helper.mjs): a log that Docker mounts from
macOS shows its growth minutes late, but the helper reads the file itself. The first answer only says how long the log
is, so the narration starts from its end like the file tail; the helper starts again from the top when the log was
recreated. Returns the function that stops following.
*/
export function tailZwiftLogOverHttp(url: string, onLine: (line: string) => void, intervalMs = 700) {
  const splitter = lineSplitter(onLine);
  let offset: number | null = null;
  let busy = false;

  const poll = async () => {
    if (busy) return;

    busy = true;

    try {
      const query = offset === null ? '' : `?offset=${offset}`;

      const response = await fetch(`${url.replace(/\/+$/, '')}/zwift-log${query}`, {
        signal: AbortSignal.timeout(3000),
      });

      const size = Number(response.headers.get('X-Log-Size'));

      const start = Number(response.headers.get('X-Log-Start') ?? size);

      if (!response.ok || !Number.isFinite(size)) return;

      if (offset !== null && start !== offset) splitter.reset();

      const text = offset === null ? '' : await response.text();

      offset = size;

      if (text) splitter.feed(text);
    } catch {
      // The helper is not there (yet): the next poll tries again.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void poll(), intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}
