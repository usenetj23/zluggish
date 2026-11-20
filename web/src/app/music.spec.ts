import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbed, parseNow } from './music';

await test('youtube watch link', () => {
  const result = parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  assert.deepStrictEqual(result, {
    kind: 'youtube',
    src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    videoId: 'dQw4w9WgXcQ',
    duckable: true,
  });
});

await test('youtube playlist link', () => {
  const result = parseEmbed('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');

  assert.deepStrictEqual(result, {
    kind: 'youtube',
    src: 'https://www.youtube-nocookie.com/embed/videoseries?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    duckable: true,
  });
});

await test('spotify playlist link', () => {
  const result = parseEmbed('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');

  assert.deepStrictEqual(result, {
    kind: 'spotify',
    src: 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
    duckable: false,
  });
});

await test('tidal album link', () => {
  const result = parseEmbed('https://tidal.com/album/12345678');

  assert.deepStrictEqual(result, {
    kind: 'tidal',
    src: 'https://embed.tidal.com/albums/12345678',
    duckable: false,
  });
});

await test('soundcloud track link', () => {
  const result = parseEmbed('https://soundcloud.com/artist/track-name');

  assert.deepStrictEqual(result, {
    kind: 'soundcloud',
    src: 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack-name&auto_play=false&visual=false',
    duckable: false,
  });
});

await test('soundcloud www prefix is stripped', () => {
  const result = parseEmbed('https://www.soundcloud.com/artist/track-name');

  assert.deepStrictEqual(result, {
    kind: 'soundcloud',
    src: 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fwww.soundcloud.com%2Fartist%2Ftrack-name&auto_play=false&visual=false',
    duckable: false,
  });
});

await test('soundcloud /discover is rejected', () => {
  assert.strictEqual(parseEmbed('https://soundcloud.com/discover'), null);
});

await test('soundcloud /you is rejected', () => {
  assert.strictEqual(parseEmbed('https://soundcloud.com/you/tracks'), null);
});

await test('deezer track link', () => {
  const result = parseEmbed('https://www.deezer.com/track/12345678');

  assert.deepStrictEqual(result, {
    kind: 'deezer',
    src: 'https://widget.deezer.com/widget/auto/track/12345678',
    duckable: false,
  });
});

await test('deezer playlist with language code', () => {
  const result = parseEmbed('https://www.deezer.com/en/playlist/987654321');

  assert.deepStrictEqual(result, {
    kind: 'deezer',
    src: 'https://widget.deezer.com/widget/auto/playlist/987654321',
    duckable: false,
  });
});

await test('deezer /en/artist/5 is rejected', () => {
  assert.strictEqual(parseEmbed('https://www.deezer.com/en/artist/5'), null);
});

await test('mixcloud show link', () => {
  const result = parseEmbed('https://www.mixcloud.com/DJsilentBob/mixtape-42/');

  assert.deepStrictEqual(result, {
    kind: 'mixcloud',
    src: 'https://www.mixcloud.com/widget/iframe/?feed=%2FDJsilentBob%2Fmixtape-42%2F&hide_cover=1',
    duckable: false,
  });
});

await test('mixcloud without trailing slash', () => {
  const result = parseEmbed('https://www.mixcloud.com/DJsilentBob/mixtape-42');

  assert.deepStrictEqual(result, {
    kind: 'mixcloud',
    src: 'https://www.mixcloud.com/widget/iframe/?feed=%2FDJsilentBob%2Fmixtape-42%2F&hide_cover=1',
    duckable: false,
  });
});

await test('mixcloud with only one segment is rejected', () => {
  assert.strictEqual(parseEmbed('https://www.mixcloud.com/DJsilentBob'), null);
});

await test('non-URL string returns null', () => {
  assert.strictEqual(parseEmbed('not a url'), null);
});

await test('unknown host returns null', () => {
  assert.strictEqual(parseEmbed('https://example.com/something'), null);
});

await test('apple music album link produces embed', () => {
  const result = parseEmbed('https://music.apple.com/us/album/album-name/1234567890');

  assert.deepStrictEqual(result, {
    kind: 'apple',
    src: 'https://embed.music.apple.com/us/album/album-name/1234567890',
    duckable: false,
  });
});

await test('apple music playlist link produces embed', () => {
  const result = parseEmbed('https://music.apple.com/gb/playlist/my-list/pl.12345');

  assert.deepStrictEqual(result, {
    kind: 'apple',
    src: 'https://embed.music.apple.com/gb/playlist/my-list/pl.12345',
    duckable: false,
  });
});

await test('apple music song link produces embed', () => {
  const result = parseEmbed('https://music.apple.com/jp/song/song-name/123');

  assert.deepStrictEqual(result, {
    kind: 'apple',
    src: 'https://embed.music.apple.com/jp/song/song-name/123',
    duckable: false,
  });
});

await test('apple music non-matching path falls back to link', () => {
  const result = parseEmbed('https://music.apple.com/browse/new');

  assert.deepStrictEqual(result, {
    kind: 'link',
    href: 'https://music.apple.com/browse/new',
    label: 'Apple Music opens in its own tab — its volume is yours to lower by hand.',
    duckable: false,
  });
});

await test('parseNow returns null for failed payload', () => {
  assert.strictEqual(parseNow({ success: false }), null);
});

await test('parseNow returns null for null input', () => {
  assert.strictEqual(parseNow(null), null);
});

await test('parseNow returns track for full payload', () => {
  const payload = {
    success: true,
    track: { id: 42, audio_url: '/stream/track.mp3', title: 'Test Song', artist: 'Test Artist' },
    offset_seconds: 10,
    remaining_ms: 120_000,
  };

  assert.deepStrictEqual(parseNow(payload), {
    id: 42,
    src: 'https://www.lucadegre.it/stream/track.mp3',
    seek: 10,
    title: 'Test Song',
    artist: 'Test Artist',
    remainingS: 120,
  });
});

await test('a station file that leads away from the station, and ids that carry more than an id, are refused', () => {
  const track = (audio_url: string) => ({ success: true, track: { id: 1, audio_url } });

  assert.equal(parseNow(track('//evil.example/a.mp3')), null);
  assert.equal(parseNow(track('/files/a.mp3'))?.src, 'https://www.lucadegre.it/files/a.mp3');
  assert.equal(parseNow(track('@evil.example/a.mp3'))?.src, 'https://www.lucadegre.it/@evil.example/a.mp3');
  assert.equal(parseEmbed('https://www.youtube.com/watch?v=abc%26autoplay%3D1'), null);
  assert.equal(parseEmbed('https://www.youtube.com/playlist?list=PL1%26autoplay%3D1'), null);
});
