import { BotProfiles, loadBotProfiles, watchBotProfiles } from '#src/world/bot-profiles';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PHOTO_URL = 'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=400';

const TEAMS = { UAD: { name: 'UAE Team Emirates', country: 'AE', website: 'https://uad.example' } };

const document = (riders: unknown): string => JSON.stringify({ version: 1, teams: TEAMS, riders });

interface RiderFixture {
  name: string;
  country: string;
  team: string;
  pcs: string;
  born: string;
  birthplace: string;
  bio: string;
  photo: { url: string; author: string; license: string; source: string };
  wikidata: string;
}

/** A value a fixture may override a catalogue field with, valid or deliberately broken. */
type FixtureValue = string | number | boolean | null | { readonly [key: string]: string };

const rider = (over: { readonly [key: string]: FixtureValue } = {}): RiderFixture => ({
  name: 'Tadej Pogačar (UAD)',
  country: 'SI',
  team: 'UAD',
  pcs: 'tadej-pogacar',
  born: '1998-09-21',
  birthplace: 'Klanec',
  bio: 'Slovenian rider.',
  photo: {
    url: PHOTO_URL,
    author: 'A',
    license: 'CC BY-SA 4.0',
    source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
  },
  wikidata: 'Q1',
  ...over,
});

await test('two riders are parsed with every field', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([
      rider(),
      rider({
        name: 'Jonas Vingegaard (TLJ)',
        country: 'DK',
        team: 'TLJ',
        pcs: 'jonas-vingegaard',
        born: '1996-12-10',
        birthplace: 'Villers-Cotterêts',
        bio: 'Danish rider.',
        wikidata: 'Q2',
      }),
    ]),
  );

  assert.equal(profiles.size, 2);

  assert.deepEqual(profiles.get('Tadej', 'Pogačar (UAD)'), {
    name: 'Tadej Pogačar (UAD)',
    countryName: 'Slovenia',
    countryCode: 705,
    teamName: 'UAE Team Emirates',
    teamWebsite: 'https://uad.example',
    born: '1998-09-21',
    birthplace: 'Klanec',
    bio: 'Slovenian rider.',
    photo: {
      url: PHOTO_URL,
      author: 'A',
      license: 'CC BY-SA 4.0',
      source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    },
    wikidata: 'Q1',
  });

  const jonas = profiles.get('Jonas', 'Vingegaard (TLJ)');

  assert.equal(jonas?.countryName, 'Denmark');
  assert.equal(jonas?.countryCode, 208);
  assert.equal(jonas?.teamName, null);
  assert.equal(jonas?.teamWebsite, null);
});

await test('riders sharing one pcs merge, the first non-empty value wins', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([
      rider({ bio: '', born: null, photo: null, birthplace: 'Klanec', wikidata: null }),
      rider({ name: 'Tadej Pogačar', bio: 'Climber.', born: '1998-09-21', birthplace: '', wikidata: 'Q1' }),
    ]),
  );

  assert.equal(profiles.size, 2);

  const merged = profiles.get('Tadej', 'Pogačar');
  const expectedPhoto = {
    url: PHOTO_URL,
    author: 'A',
    license: 'CC BY-SA 4.0',
    source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
  };

  assert.deepEqual(merged, {
    name: 'Tadej Pogačar',
    countryName: 'Slovenia',
    countryCode: 705,
    teamName: 'UAE Team Emirates',
    teamWebsite: 'https://uad.example',
    born: '1998-09-21',
    birthplace: 'Klanec',
    bio: 'Climber.',
    photo: expectedPhoto,
    wikidata: 'Q1',
  });
  assert.equal(merged?.name, 'Tadej Pogačar');
  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.name, 'Tadej Pogačar (UAD)');
  assert.deepEqual(Object.keys(profiles.get('Tadej', 'Pogačar (UAD)') ?? {}).sort(), Object.keys(merged ?? {}).sort());
  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.bio, merged?.bio);
});

await test('a photo from the wrong host is dropped but the rider stays', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([rider({ photo: { ...rider().photo, url: 'https://example.com/x.jpg' } })]),
  );

  assert.equal(profiles.size, 1);
  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.photo, null);
});

await test('a cyclingdb photo keeps its url including the ?v= query', { timeout: 10_000 }, () => {
  const cyclingDbUrl = 'https://static.cyclingdb.com/4272/conversions/lorenzo-rota-cutout-cutout.webp?v=1791568323';
  const profiles = BotProfiles.parse(document([rider({ photo: { ...rider().photo, url: cyclingDbUrl } })]));

  assert.deepEqual(profiles.get('Tadej', 'Pogačar (UAD)')?.photo, {
    url: cyclingDbUrl,
    author: 'A',
    license: 'CC BY-SA 4.0',
    source: 'https://commons.wikimedia.org/wiki/File:X.jpg',
  });
});

await test('a photo from a cyclingdb lookalike host or plain http is dropped', { timeout: 10_000 }, () => {
  const lookalike = BotProfiles.parse(
    document([rider({ photo: { ...rider().photo, url: 'https://static.cyclingdb.com.evil.example/x.webp' } })]),
  );
  const plainHttp = BotProfiles.parse(
    // eslint-disable-next-line unicorn/prefer-https -- the plain http photo is exactly what this test refuses.
    document([rider({ photo: { ...rider().photo, url: 'http://static.cyclingdb.com/x.webp' } })]),
  );

  assert.equal(lookalike.get('Tadej', 'Pogačar (UAD)')?.photo, null);
  assert.equal(plainHttp.get('Tadej', 'Pogačar (UAD)')?.photo, null);
});

await test('a photo without an author is dropped', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(document([rider({ photo: { ...(rider().photo as object), author: '' } })]));

  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.photo, null);
});

await test('an impossible or malformed born is dropped, a bare year is kept', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([
      rider({ name: 'Bad Day', pcs: 'bad-day', born: '1998-02-31' }),
      rider({ name: 'Short Year', pcs: 'short-year', born: '98-01-01' }),
      rider({ name: 'Year Only', pcs: 'year-only', born: '1998' }),
    ]),
  );

  assert.equal(profiles.get('Bad', 'Day')?.born, null);
  assert.equal(profiles.get('Short', 'Year')?.born, null);
  assert.equal(profiles.get('Year', 'Only')?.born, '1998');
});

await test('a 500 character bio is cut to 400', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(document([rider({ bio: 'a'.repeat(500) })]));
  const bio = profiles.get('Tadej', 'Pogačar (UAD)')?.bio;

  assert.equal(bio?.length, 400);
  assert.equal(bio, 'a'.repeat(400));
});

await test('country XK becomes Kosovo and an unknown code becomes null', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([
      rider({ name: 'Kosovo Rider', pcs: 'kosovo-rider', country: 'XK' }),
      rider({ name: 'Bad Country', pcs: 'bad-country', country: 'Slovenija' }),
    ]),
  );

  assert.equal(profiles.get('Kosovo', 'Rider')?.countryName, 'Kosovo');
  assert.equal(profiles.get('Kosovo', 'Rider')?.countryCode, null);
  assert.equal(profiles.get('Bad', 'Country')?.countryName, null);
  assert.equal(profiles.get('Bad', 'Country')?.countryCode, null);
});

await test('the catalogue country also yields the numeric country code', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(
    document([
      rider({ name: 'Slovenian Rider', pcs: 'slovenian-rider' }),
      rider({ name: 'No Country', pcs: 'no-country', country: null }),
    ]),
  );

  assert.equal(profiles.get('Slovenian', 'Rider')?.countryCode, 705);
  assert.equal(profiles.get('No', 'Country')?.countryCode, null);
});

await test('a rider with an unknown team code has no team name', { timeout: 10_000 }, () => {
  const profiles = BotProfiles.parse(document([rider({ team: 'XXX' })]));

  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.teamName, null);
  assert.equal(profiles.get('Tadej', 'Pogačar (UAD)')?.teamWebsite, null);
});

await test('garbage JSON yields an empty catalogue', { timeout: 10_000 }, () => {
  assert.equal(BotProfiles.parse('not json at all {').size, 0);
  assert.equal(BotProfiles.empty().size, 0);
});

await test('loadBotProfiles of a missing path yields an empty catalogue', { timeout: 10_000 }, () => {
  assert.equal(loadBotProfiles(join('storage', 'definitely-missing-bot-profiles.json')).size, 0);
});

await test('get of an unknown name is undefined', { timeout: 10_000 }, () => {
  assert.equal(BotProfiles.parse(document([rider()])).get('Nobody', 'There'), undefined);
});

await test('a file written after creation but before the first call is seen', { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-profiles-'));

  try {
    const clock = 0;
    const now = () => clock;
    const path = join(dir, 'profiles.json');
    const watch = watchBotProfiles(path, now, 1000);

    writeFileSync(path, document([rider()]));

    assert.equal(watch().size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('an edit is seen only after the recheck window', { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-profiles-'));

  try {
    let clock = 0;
    const now = () => clock;
    const path = join(dir, 'profiles.json');
    const watch = watchBotProfiles(path, now, 1000);

    writeFileSync(path, document([rider()]));
    assert.equal(watch().size, 1);

    writeFileSync(
      path,
      document([
        rider(),
        rider({ name: 'Jonas Vingegaard (TLJ)', pcs: 'jonas-vingegaard', country: 'DK', team: 'TLJ' }),
      ]),
    );

    clock = 500;
    assert.equal(watch().size, 1);

    clock = 1000;
    assert.equal(watch().size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('a deleted file yields an empty catalogue after the window', { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-profiles-'));

  try {
    let clock = 0;
    const now = () => clock;
    const path = join(dir, 'profiles.json');
    const watch = watchBotProfiles(path, now, 1000);

    writeFileSync(path, document([rider()]));
    assert.equal(watch().size, 1);

    unlinkSync(path);
    clock = 1000;
    assert.equal(watch().size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('watching a path that never exists yields an empty catalogue', { timeout: 10_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-profiles-'));

  try {
    let clock = 0;
    const now = () => clock;
    const watch = watchBotProfiles(join(dir, 'definitely-missing.json'), now, 1000);

    assert.equal(watch().size, 0);

    clock = 2000;
    assert.equal(watch().size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
