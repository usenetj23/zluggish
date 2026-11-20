/**
 * Music alongside the read-aloud ride: the NowPlay radio the Zwift community
 * runs (five shuffled channels of Zwift-friendly songs) plus web players pasted
 * in as links. The radio streams plain files, so its volume is ours to ride —
 * the same ducking the voice uses: smooth down to five percent while TTS
 * speaks, a slow ramp back up when the last sentence ends.
 */

export const radioOrigin = 'https://www.lucadegre.it';
export const radioApi = `${radioOrigin}/nowplay/radio/api.php`;

export const radioChannels = [
  { slug: '', name: 'All Songs' },
  { slug: 'zwift-time', name: 'Zwift Time' },
  { slug: 'luca-de-gregorio-playlist-2', name: "Luca's Favorite" },
  { slug: 'abyss-bloom', name: 'Abyss Bloom' },
  { slug: 'pop', name: 'Pop' },
];

export type NowTrack = { id: number; src: string; seek: number; title: string; artist: string; remainingS: number };

/** The station's now-playing payload, turned into something to play right now. */
export type NowPayload = {
  success?: boolean;
  track?: { id: number; audio_url?: string; title?: string; artist?: string };
  offset_seconds?: number;
  remaining_ms?: number;
};

/** A file of the station: a path that leads anywhere else than the station is no file of it. */
function radioFile(path: string) {
  const url = new URL(path, radioOrigin);

  return url.origin === radioOrigin ? url.href : '';
}

export function parseNow(record: NowPayload | null): NowTrack | null {
  if (!record?.success || !record.track?.audio_url) return null;

  const src = radioFile(record.track.audio_url);

  if (!src) return null;

  return {
    id: record.track.id,
    src,
    seek: record.offset_seconds ?? 0,
    title: record.track.title ?? '',
    artist: record.track.artist ?? '',
    remainingS: (record.remaining_ms ?? 0) / 1000,
  };
}

export type Embed =
  | { kind: 'youtube'; src: string; videoId?: string; listId?: string; duckable: true }
  | { kind: 'spotify' | 'tidal' | 'soundcloud' | 'deezer' | 'mixcloud' | 'apple'; src: string; duckable: false }
  | { kind: 'link'; href: string; label: string; duckable: false };

const soundcloudBlocked = new Set([
  'discover',
  'stream',
  'you',
  'upload',
  'search',
  'feed',
  'charts',
  'pages',
  'terms-of-use',
]);

const deezerTypes = new Set(['track', 'album', 'playlist', 'episode', 'show']);

/** Recognise the playlist and track links the streaming services hand out. */
export function parseEmbed(url: string): Embed | null {
  let where: URL;

  try {
    where = new URL(url.trim());
  } catch {
    return null;
  }

  const host = where.hostname.replace(/^www\./, '');
  const id = (pattern: RegExp) => where.pathname.match(pattern)?.[1] ?? null;
  const safeId = (value: string | null) => (value !== null && /^[\w-]+$/.test(value) ? value : null);

  if (host === 'youtu.be') {
    const video = id(/^\/([\w-]+)\/?$/);

    return video
      ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${video}`, videoId: video, duckable: true }
      : null;
  }

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = safeId(where.searchParams.get('list')) ?? id(/^\/playlist\/([\w-]+)/);

    if (list)
      return {
        kind: 'youtube',
        src: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
        listId: list,
        duckable: true,
      };

    const video = safeId(where.searchParams.get('v')) ?? id(/^\/shorts\/([\w-]+)/);

    return video
      ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${video}`, videoId: video, duckable: true }
      : null;
  }

  const media = where.pathname.match(/^\/(playlist|album|track)\/([\w-]+)/);

  if (host === 'open.spotify.com' && media)
    return { kind: 'spotify', src: `https://open.spotify.com/embed/${media[1]}/${media[2]}`, duckable: false };

  if (host === 'tidal.com' && media)
    return { kind: 'tidal', src: `https://embed.tidal.com/${media[1]}s/${media[2]}`, duckable: false };

  if (host === 'soundcloud.com') {
    const segments = where.pathname.split('/').filter(Boolean);

    if (segments.length >= 1 && !soundcloudBlocked.has(segments[0])) {
      const playerUrl = encodeURIComponent(where.origin + where.pathname);

      return {
        kind: 'soundcloud',
        src: `https://w.soundcloud.com/player/?url=${playerUrl}&auto_play=false&visual=false`,
        duckable: false,
      };
    }

    return null;
  }

  if (host === 'deezer.com') {
    const match = where.pathname.match(/^\/(?:([a-z]{2})\/)?(track|album|playlist|episode|show)\/(\d+)$/);

    if (match && deezerTypes.has(match[2]))
      return {
        kind: 'deezer',
        src: `https://widget.deezer.com/widget/auto/${match[2]}/${match[3]}`,
        duckable: false,
      };

    return null;
  }

  if (host === 'mixcloud.com') {
    const segments = where.pathname.split('/').filter(Boolean);

    if (segments.length === 2) {
      const feed = encodeURIComponent(`/${segments[0]}/${segments[1]}/`);

      return {
        kind: 'mixcloud',
        src: `https://www.mixcloud.com/widget/iframe/?feed=${feed}&hide_cover=1`,
        duckable: false,
      };
    }

    return null;
  }

  if (host === 'music.apple.com') {
    const appleMatch = where.pathname.match(/^\/[a-z]{2}\/(album|playlist|song)\/.+/);

    if (appleMatch)
      return {
        kind: 'apple',
        src: `https://embed.music.apple.com${where.pathname}${where.search}`,
        duckable: false,
      };

    return {
      kind: 'link',
      href: where.href,
      label: 'Apple Music opens in its own tab — its volume is yours to lower by hand.',
      duckable: false,
    };
  }

  if (host === 'music.amazon.com' || host.endsWith('music.amazon.de'))
    return {
      kind: 'link',
      href: where.href,
      label: 'Amazon Music opens in its own tab — its volume is yours to lower by hand.',
      duckable: false,
    };

  return null;
}

/**
 * Smooth volume ramps for whatever music is playing: quick but soft down while
 * the voice speaks, slow and rising back to the listening level afterwards.
 */
export class Ducker {
  private level: number;
  private ramp: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly apply: (level: number) => void) {
    this.level = 1;
  }

  private to(target: number, perTick: number) {
    clearInterval(this.ramp);

    this.ramp = setInterval(() => {
      const distance = target - this.level;

      if (Math.abs(distance) <= perTick) {
        this.level = target;
        this.apply(target);
        clearInterval(this.ramp);
        this.ramp = undefined;

        return;
      }

      this.level += Math.sign(distance) * perTick;
      this.apply(this.level);
    }, 50);
  }

  duck() {
    this.to(0.05, 0.06);
  }

  unduck(level: number) {
    this.to(Math.max(0, level), 0.015);
  }

  at(level: number) {
    clearInterval(this.ramp);
    this.ramp = undefined;
    this.level = level;
    this.apply(level);
  }
}
