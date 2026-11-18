import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** What a segment is: a sprint (green jersey), a KOM climb (polka dot jersey) or any other segment. */
export type SegmentKind = 'sprint' | 'kom' | 'segment';

export interface Segment {
  name: string;
  kind: SegmentKind;
}

const gameInfo = z.object({
  segments: z.array(
    z.object({
      id: z.string(),
      archFriendlyName: z.string().optional(),
      jerseyName: z.string().optional(),
      jerseyIconPath: z.string().optional(),
    }),
  ),
});

export function segmentKind(icon = ''): SegmentKind {
  if (icon.includes('Green')) return 'sprint';

  if (icon.includes('Polka')) return 'kom';

  return 'segment';
}

/** Names and kinds of the segments by the segment id the game sends, from data/game_info.txt. */
export function loadSegments(assets: string) {
  // Some ids are numbers beyond 2^53 that JSON.parse would round: read every id as text.
  const text = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8')
    .replace(/^\u{FEFF}/u, '')
    .replaceAll(/("id"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"');

  const segments = new Map<string, Segment>();

  for (const item of gameInfo.parse(JSON.parse(text)).segments) {
    const name = item.archFriendlyName || item.jerseyName;

    if (name) segments.set(item.id, { name, kind: segmentKind(item.jerseyIconPath) });
  }

  return segments;
}

/** 18467 -> '18.5 s', 531878 -> '8:52', 3605000 -> '1:00:05'. */
export function formatTime(milliseconds: number, comma = false) {
  const seconds = milliseconds / 1000;

  if (Math.round(seconds * 10) / 10 < 60) {
    const text = `${seconds.toFixed(1)} s`;

    return comma ? text.replace('.', ',') : text;
  }

  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');

  if (total < 3600) return `${minutes}:${rest}`;

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}
