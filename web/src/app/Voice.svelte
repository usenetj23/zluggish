<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Ducker, parseEmbed, parseNow, radioApi, radioChannels, type Embed } from './music';

  type VoiceEvent = { kind: string; speak: string; self?: boolean; lang?: string };

  let language = $state('pl');
  let voiceName = $state('');
  let rate = $state(1.05);
  let volume = $state(1);
  let speakChat = $state(true);
  let speakOwn = $state(false);
  let speakWorkout = $state(true);
  let voiceNames = $state<string[]>([]);
  let statusText = $state('off');
  let connected = $state(false);
  let feed = $state<{ id: number; at: string; kind: string; speak: string; heard: boolean }[]>([]);
  let feedId = 0;

  let started = $state(false);

  let channelSlug = $state('zwift-time');
  let musicVolume = $state(0.5);
  let nowTitle = $state('');
  let embed = $state<Embed | null>(null);
  let embedInput = $state('');
  let musicNote = $state('');

  let radio: HTMLAudioElement | undefined;
  let radioTrackId = 0;
  let radioNext: ReturnType<typeof setTimeout> | undefined;
  let pendingSeek = 0;
  let ytPlayer: YtPlayer | undefined;
  let ytApi: Promise<YtApi> | undefined;
  let speaking = 0;
  let unduckTimer: ReturnType<typeof setTimeout> | undefined;

  // Whatever music is playing bends around the voice: soft down to five
  // percent while a sentence is spoken, a slow rising ramp back after.
  const ducker = new Ducker((level) => {
    if (radio) radio.volume = level;

    ytPlayer?.setVolume(Math.round(level * 100));
  });

  async function youTubeApi(): Promise<YtApi> {
    ytApi ??= new Promise((resolve) => {
      if (window.YT?.Player) resolve(window.YT);

      const previous = window.onYouTubeIframeAPIReady;

      window.onYouTubeIframeAPIReady = () => {
        previous?.();

        if (window.YT) resolve(window.YT);
      };

      const tag = document.createElement('script');

      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.append(tag);
    });

    return ytApi;
  }

  async function syncRadio(force = false) {
    if (!radio) return;

    try {
      const response = await fetch(`${radioApi}?action=now${channelSlug === '' ? '' : '&channel=' + channelSlug}`);
      const track = parseNow(await response.json());

      if (!track) {
        musicNote = 'the station did not answer';

        return;
      }

      nowTitle = `${track.artist} — ${track.title}`;
      musicNote = '';

      if (force || track.id !== radioTrackId) {
        radioTrackId = track.id;
        pendingSeek = track.seek;
        radio.src = track.src;
        await radio.play();
      }

      clearTimeout(radioNext);
      radioNext = setTimeout(() => void syncRadio(), Math.max(5, track.remainingS - 1) * 1000);
    } catch {
      musicNote = 'the station is unreachable';
    }
  }

  function playRadio() {
    stopMusic(false);
    radio = new Audio();
    ducker.at(musicVolume);
    radio.addEventListener('ended', () => void syncRadio(true));
    radio.addEventListener('loadedmetadata', () => {
      if (pendingSeek > 0 && radio) radio.currentTime = pendingSeek;

      pendingSeek = 0;
    });
    void syncRadio(true);
  }

  function playEmbed() {
    const placed = parseEmbed(embedInput);

    if (!placed) {
      musicNote = 'that link is not a playlist or track I recognise';

      return;
    }

    musicNote = '';
    stopMusic(false);
    embed = placed;

    if (placed.kind === 'youtube') {
      void (async () => {
        const api = await youTubeApi();

        await tick();

        const playerVars: YtPlayerVars = { autoplay: 1 };

        if (placed.kind === 'youtube' && placed.listId) {
          playerVars.listType = 'playlist';
          playerVars.list = placed.listId;
        }

        ytPlayer = new api.Player('yt-host', {
          videoId: placed.kind === 'youtube' ? (placed.videoId ?? '') : '',
          playerVars,
        });
        ducker.at(musicVolume);
      })();
    }
  }

  function stopMusic(clearEmbed = true) {
    clearTimeout(radioNext);
    radioNext = undefined;
    radio?.pause();
    radio = undefined;
    radioTrackId = 0;
    pendingSeek = 0;
    nowTitle = '';

    if (ytPlayer) {
      ytPlayer.stopVideo();
      ytPlayer.destroy();
      ytPlayer = undefined;
    }

    if (clearEmbed) embed = null;
  }

  let source: EventSource | undefined;
  let channel: BroadcastChannel | undefined;
  let otherTab = '';
  let heardAt = 0;

  // One voice per browser: the newest tab claims the ride, older tabs fall silent.
  const claim = () => channel?.postMessage({ claim: myId });
  const myId = Math.random().toString(36).slice(2);

  const allowed = (event: VoiceEvent) => (event.kind === 'chat' ? (event.self ? speakOwn : speakChat) : speakWorkout);

  /** One spoken sentence is over: the music rises again once nothing is left to say. */
  function sentenceEnded() {
    speaking = Math.max(0, speaking - 1);

    if (speaking === 0) {
      clearTimeout(unduckTimer);
      // A short pause between queued sentences must not lift the music twice.
      unduckTimer = setTimeout(() => ducker.unduck(musicVolume), 400);
    }
  }

  function sayBrowser(text: string, lang: string) {
    if (!window.speechSynthesis) {
      statusText = 'this browser has no speech synthesis';

      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);

    // A chosen voice only fits its own words: captions from the workout stay
    // English, bot chat is spoken in the language the bots wrote it in.
    const voice =
      lang === language
        ? speechSynthesis.getVoices().find((v) => v.name === voiceName)
        : speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));

    if (voice) utterance.voice = voice;

    utterance.lang = lang === 'pl' ? 'pl-PL' : 'en-GB';
    utterance.rate = rate;
    utterance.volume = Math.min(volume, 0.85);
    // macOS voices end with a click when the buffer stops dead: pad the tail.
    utterance.text = `${text} `;

    utterance.onstart = () => {
      speaking++;
      clearTimeout(unduckTimer);
      ducker.duck();
    };

    const finished = sentenceEnded;

    utterance.onend = finished;
    utterance.onerror = finished;
    speechSynthesis.speak(utterance);
  }

  function say(text: string, lang = language) {
    sayBrowser(text, lang);
  }

  function fillVoices() {
    const all = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const local = all.filter((v) => v.lang.toLowerCase().startsWith(language));

    voiceNames = (local.length > 0 ? local : all).map((v) => v.name);

    if (voiceName && !voiceNames.includes(voiceName)) voiceName = '';
  }

  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function connect() {
    source?.close();
    connected = false;
    source = new EventSource(`/api/voice/stream?language=${language}`);
    source.onopen = () => {
      connected = true;
      statusText = 'listening';
    };

    source.onerror = () => {
      connected = false;
      statusText = 'reconnecting — is this browser signed in to the app?';
    };

    for (const kind of ['chat', 'summary', 'block', 'countdown', 'finish', 'start', 'target', 'cue'])
      source.addEventListener(kind, (event: MessageEvent<string>) => {
        const data: VoiceEvent = JSON.parse(event.data);
        const heard = started && allowed(data);

        // The feed shows everything the server sent, even what a filter muted.
        feed = [{ id: feedId++, at: stamp(), kind: data.kind, speak: data.speak, heard }, ...feed].slice(0, 40);

        if (heard) say(data.speak, data.lang ?? language);
      });
  }

  function toggle() {
    if (started) stop();
    else start();
  }

  function start() {
    started = true;
    otherTab = '';
    statusText = 'connecting…';
    claim();
    connect();
  }

  function stop(whenSilent = 'off') {
    started = false;
    connected = false;
    source?.close();
    source = undefined;
    speechSynthesis.cancel();
    statusText = otherTab ? whenSilent : 'off';
  }

  function persist() {
    localStorage.setItem(
      'zluggish-voice',
      JSON.stringify({
        language,
        voiceName,
        rate,
        volume,
        speakChat,
        speakOwn,
        speakWorkout,
        channelSlug,
        musicVolume,
      }),
    );
  }

  function chooseLanguage() {
    fillVoices();
    persist();

    if (started) connect();
  }

  /** A stored number (an older page kept some as text) inside its range, or the default. */
  function level(stored: string | number | boolean | undefined, fallback: number, min: number, max: number) {
    const parsed = stored === undefined || stored === '' ? Number.NaN : Number(stored);

    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function flag(stored: string | number | boolean | undefined, fallback: boolean) {
    return stored === undefined ? fallback : stored === true || stored === 'true';
  }

  onMount(() => {
    try {
      const saved: Partial<Record<string, string | number | boolean>> = JSON.parse(
        localStorage.getItem('zluggish-voice') || '{}',
      );

      language = saved.language === 'en' ? 'en' : 'pl';
      voiceName = saved.voiceName === undefined ? voiceName : String(saved.voiceName);
      rate = level(saved.rate, rate, 0.6, 1.6);
      volume = level(saved.volume, volume, 0, 1);
      speakChat = flag(saved.speakChat, speakChat);
      speakOwn = flag(saved.speakOwn, speakOwn);
      speakWorkout = flag(saved.speakWorkout, speakWorkout);
      channelSlug = saved.channelSlug === undefined ? channelSlug : String(saved.channelSlug);
      musicVolume = level(saved.musicVolume, musicVolume, 0, 1);
    } catch {
      // Settings are a convenience: a broken store starts defaults.
    }

    fillVoices();

    // Voices load late in some browsers: poll a little so the list is never empty.
    let tries = 0;

    const poll = setInterval(() => {
      fillVoices();

      if (++tries > 10 || voiceNames.length > 0) clearInterval(poll);
    }, 700);

    speechSynthesis.addEventListener('voiceschanged', fillVoices);

    channel = new BroadcastChannel('zluggish-voice');

    channel.onmessage = (event: MessageEvent<{ claim?: string; alive?: string }>) => {
      const from = event.data.claim ?? event.data.alive;

      if (!from || from === myId) return;

      heardAt = Date.now();

      if (event.data.claim) {
        otherTab = from;
        stop('silent — another tab reads the ride');
      }
    };

    const heartbeat = setInterval(() => {
      if (started) channel?.postMessage({ alive: myId });
      else if (otherTab && Date.now() - heardAt > 5000) {
        // The claiming tab is gone: take the voice back.
        otherTab = '';
        start();
      }
    }, 2500);

    start();

    return () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      channel?.close();
      speechSynthesis.removeEventListener('voiceschanged', fillVoices);
      source?.close();
      speechSynthesis.cancel();
      stopMusic();
      clearTimeout(unduckTimer);
    };
  });
</script>

<section class="voice-panel">
  <p class="lead">
    The ride read aloud: chat bubbles of the game and the blocks of a running workout are spoken by the browser's own
    voice, in the language you pick — with music underneath: the Zwift Time radio or your own playlist, ducked smoothly
    whenever the voice speaks. This page starts listening the moment you open it — keep it open on any device while you
    ride.
  </p>
  <p class="status" class:on={started && connected} class:warn={started && !connected} aria-live="polite">
    <span class="dot"></span>
    {statusText}
    {#if started && connected && voiceNames.length > 0}<span class="muted">· {voiceNames.length} voices</span>{/if}
  </p>
  <div class="fields">
    <label>
      language
      <select bind:value={language} onchange={chooseLanguage}>
        <option value="pl">polski</option>
        <option value="en">English</option>
      </select>
    </label>
    <label>
      voice
      <select bind:value={voiceName} onchange={persist}>
        <option value="">(default voice)</option>
        {#each voiceNames as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
    <label>
      rate <span class="muted">{rate.toFixed(2)}</span>
      <input type="range" min="0.6" max="1.6" step="0.05" bind:value={rate} onchange={persist} />
    </label>
    <label>
      volume <span class="muted">{volume.toFixed(2)}</span>
      <input type="range" min="0" max="1" step="0.05" bind:value={volume} onchange={persist} />
    </label>
  </div>
  <p class="checks">
    <label><input type="checkbox" bind:checked={speakChat} onchange={persist} /> chat</label>
    <label><input type="checkbox" bind:checked={speakOwn} onchange={persist} /> own messages</label>
    <label><input type="checkbox" bind:checked={speakWorkout} onchange={persist} /> workout</label>
  </p>
  <p class="buttons">
    <button type="button" class:active={started} aria-pressed={started} onclick={toggle}
      >{started ? 'voice: on' : 'voice: off'}</button
    >
    <button
      type="button"
      onclick={() =>
        say(
          language === 'pl'
            ? 'Test głosu. Raz dwa trzy. Cel mocy: dwieście watów.'
            : 'Voice test. One two three. Power target: two hundred watts.',
        )}>test voice</button
    >
  </p>
  <h3>Music</h3>
  <div class="fields">
    <label>
      radio channel
      <select
        bind:value={channelSlug}
        onchange={() => {
          persist();
          if (radio) void syncRadio(true);
        }}
      >
        {#each radioChannels as option (option.slug)}<option value={option.slug}>{option.name}</option>{/each}
      </select>
    </label>
    <label>
      music volume <span class="muted">{musicVolume.toFixed(2)}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        bind:value={musicVolume}
        onchange={() => {
          ducker.at(musicVolume);
          persist();
        }}
      />
    </label>
  </div>
  <p class="buttons">
    <button type="button" onclick={playRadio}>play radio</button>
    <button type="button" onclick={() => stopMusic()}>stop music</button>
  </p>
  {#if nowTitle}<p class="muted">on air: {nowTitle}</p>{/if}
  <p class="embed">
    <label>
      or paste a playlist link
      <input type="url" bind:value={embedInput} placeholder="https://open.spotify.com/playlist/…" />
    </label>
    <button type="button" onclick={playEmbed}>play link</button>
  </p>
  {#if embed?.kind === 'youtube'}
    <div id="yt-host" class="player"></div>
  {:else if embed && embed.kind !== 'link'}
    <iframe class="player" src={embed.src} allow="autoplay; encrypted-media; clipboard-write" title="web player"
    ></iframe>
  {:else if embed?.kind === 'link'}
    <p class="muted">{embed.label} <a href={embed.href} target="_blank" rel="noopener">open {embed.label}</a></p>
  {/if}
  {#if musicNote}<p class="warn-text">{musicNote}</p>{/if}
  <p class="muted">
    the radio and any YouTube playlist duck to 5% while the voice speaks and rise back slowly; Spotify and Tidal players
    play inside their own frame — lower their volume by hand. Apple and Amazon open in their own tab.
  </p>
  {#if feed.length > 0}
    <h3>What the server just sent</h3>
    <ul class="feed">
      {#each feed as entry (entry.id)}
        <li class:muted={!entry.heard}>
          <span class="when">{entry.at}</span>
          <span class="kind">{entry.kind}</span>
          {entry.speak}
        </li>
      {/each}
    </ul>
    <p class="muted">dimmed lines arrived but a setting keeps them silent</p>
  {:else}
    <p class="muted">Nothing arrived yet: start a ride or chat, and its events show up here.</p>
  {/if}
</section>

<style>
  /* Panels match the settings panels: 34rem of content plus padding. */
  .voice-panel {
    max-width: 34rem;
  }
  .lead {
    margin: 0 0 1rem;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    margin: 0 0 1rem;
  }
  .dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.3);
  }
  .status.on .dot {
    background: #4cd964;
  }
  .status.warn .dot {
    background: #ffcc00;
  }
  button.active {
    border-color: #4cd964;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .fields select,
  .fields input[type='range'] {
    width: 100%;
  }
  .checks label {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    margin-right: 1.2rem;
  }
  .buttons button {
    margin-right: 0.5rem;
  }
  .feed {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.9rem;
    opacity: 0.9;
  }
  .feed li {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.15rem 0;
  }
  .when,
  .kind {
    font-size: 0.75rem;
    opacity: 0.65;
    flex: none;
  }
  .kind {
    min-width: 4.5rem;
  }
  .muted {
    opacity: 0.7;
  }
  .embed {
    display: flex;
    gap: 0.6rem;
    align-items: end;
  }
  .embed label {
    flex: 1;
  }
  .embed input {
    width: 100%;
  }
  .player {
    width: 100%;
    min-height: 12rem;
    border: 0;
    margin-top: 0.5rem;
  }
  .warn-text {
    color: #ffcc00;
  }
</style>
