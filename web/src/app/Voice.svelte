<script lang="ts">
  import { onMount } from 'svelte';

  type VoiceEvent = { kind: string; speak: string; self?: boolean; lang?: string };

  let language = $state('pl');
  let voiceName = $state('');
  let rate = $state(1.05);
  let volume = $state(1);
  let speakChat = $state(true);
  let speakOwn = $state(false);
  let speakWorkout = $state(true);
  let voiceNames = $state<Array<string>>([]);
  let statusText = $state('off');
  let connected = $state(false);
  let feed = $state<Array<{ id: number; at: string; kind: string; speak: string; heard: boolean }>>([]);
  let feedId = 0;

  let started = $state(false);

  let speaking = 0;

  let source: EventSource | undefined;
  let channel: BroadcastChannel | undefined;
  let otherTab = '';
  let heardAt = 0;

  // One voice per browser: the newest tab claims the ride, older tabs fall silent.
  const claim = () => channel?.postMessage({ claim: myId });
  const myId = Math.random().toString(36).slice(2);

  const allowed = (event: VoiceEvent) => (event.kind === 'chat' ? (event.self ? speakOwn : speakChat) : speakWorkout);

  /** One spoken sentence is over. */
  function sentenceEnded() {
    speaking = Math.max(0, speaking - 1);
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

    if (voice) {
      utterance.voice = voice;
    }

    utterance.lang = lang === 'pl' ? 'pl-PL' : 'en-GB';
    utterance.rate = rate;
    utterance.volume = Math.min(volume, 0.85);
    // macOS voices end with a click when the buffer stops dead: pad the tail.
    utterance.text = `${text} `;

    utterance.onstart = () => {
      speaking++;
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

    if (voiceName && !voiceNames.includes(voiceName)) {
      voiceName = '';
    }
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

    for (const kind of ['chat', 'summary', 'block', 'countdown', 'finish', 'start', 'target', 'cue']) {
      source.addEventListener(kind, (event: MessageEvent<string>) => {
        const data: VoiceEvent = JSON.parse(event.data);
        const heard = started && allowed(data);

        // The feed shows everything the server sent, even what a filter muted.
        feed = [{ id: feedId++, at: stamp(), kind: data.kind, speak: data.speak, heard }, ...feed].slice(0, 40);

        if (heard) {
          say(data.speak, data.lang ?? language);
        }
      });
    }
  }

  function toggle() {
    if (started) {
      stop();
    } else {
      start();
    }
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
      }),
    );
  }

  function chooseLanguage() {
    fillVoices();
    persist();

    if (started) {
      connect();
    }
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
    } catch {
      // Settings are a convenience: a broken store starts defaults.
    }

    fillVoices();

    // Voices load late in some browsers: poll a little so the list is never empty.
    let tries = 0;

    const poll = setInterval(() => {
      fillVoices();

      if (++tries > 10 || voiceNames.length > 0) {
        clearInterval(poll);
      }
    }, 700);

    speechSynthesis.addEventListener('voiceschanged', fillVoices);

    channel = new BroadcastChannel('zluggish-voice');

    channel.onmessage = (event: MessageEvent<{ claim?: string; alive?: string }>) => {
      const from = event.data.claim ?? event.data.alive;

      if (!from || from === myId) {
        return;
      }

      heardAt = Date.now();

      if (event.data.claim) {
        otherTab = from;
        stop('silent — another tab reads the ride');
      }
    };

    const heartbeat = setInterval(() => {
      if (started) {
        channel?.postMessage({ alive: myId });
      } else if (otherTab && Date.now() - heardAt > 5000) {
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
    };
  });
</script>

<section class="voice-panel">
  <p class="lead">
    The ride read aloud: chat bubbles of the game and the blocks of a running workout are spoken by the browser's own
    voice, in the language you pick. This page starts listening the moment you open it — keep it open on any device
    while you ride.
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
</style>
