<script lang="ts">
  import { onMount } from 'svelte';
  import type { Api } from '../lib/api';
  import { decode } from '../lib/api';
  import { requestJson } from '../lib/connection';
  import { t } from '../lib/i18n/index';
  import { groupWindows, overlayStatus, popupFeatures, settingsUrl, webWindowsResponse, windowUrl } from './overlay';
  import type { WebWindow } from './overlay';

  let {
    api,
    csrf,
  }: {
    api: Api;
    csrf: () => string;
  } = $props();

  let enabled = $state(false);
  let loaded = $state(false);
  let saving = $state(false);
  let failure = $state('');
  let savedMessage = $state('');
  let windows = $state<Array<WebWindow> | null>(null);
  let windowsFailure = $state('');
  const groups = $derived(groupWindows(windows ?? []));

  onMount(async () => {
    try {
      ({ enabled } = await api(overlayStatus, '/api/me/overlay'));
      loaded = true;

      if (enabled) {
        await loadWindows();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : t('overlay_state_unavailable');
      loaded = true;
    }
  });

  /** The widget RPC answers with an envelope, not the app's usual body: same session and CSRF as every other POST. */
  async function loadWindows() {
    try {
      const { response, body } = await requestJson('/api/rpc/v1/getWebWindowManifests', {
        method: 'POST',
        headers: new Headers({ 'X-CSRF-Token': csrf(), 'Content-Type': 'application/json' }),
        body: '[]',
      });
      const answer = decode(webWindowsResponse, body);

      if (!response.ok || !answer.success) {
        throw new Error(answer.error?.message || t('overlay_windows_unavailable'));
      }

      windows = answer.value ?? [];
      windowsFailure = '';
    } catch (error) {
      windowsFailure = error instanceof Error ? error.message : t('overlay_windows_unavailable');
    }
  }

  /** A single switch saves as soon as it changes, and flips back if the server refuses it. */
  async function save() {
    saving = true;
    failure = '';
    savedMessage = '';

    try {
      ({ enabled } = await api(overlayStatus, '/api/me/overlay', 'PUT', { enabled }));
      savedMessage = enabled ? t('overlay_turned_on') : t('overlay_turned_off');

      if (enabled && windows === null) {
        await loadWindows();
      }
    } catch (error) {
      enabled = !enabled;
      failure = error instanceof Error ? error.message : t('overlay_state_not_saved');
    } finally {
      saving = false;
    }
  }

  /** The click is the user gesture a popup needs: same-origin pages, named after the manifest. */
  const openWindow = (item: WebWindow, url: string) => {
    window.open(url, item.type, popupFeatures(item));
  };
</script>

{#snippet list(items: Array<WebWindow>)}
  <ul class="windows">
    {#each items as item (item.type)}
      <li>
        <span class="line"><span class="name">{item.prettyName}</span></span>
        {#if item.prettyDesc}<span class="detail">{item.prettyDesc}</span>{/if}
        <span class="actions">
          <button type="button" onclick={() => openWindow(item, windowUrl(item))}>{t('open')}</button>
          {#if item.settingsFile}
            <button type="button" onclick={() => openWindow(item, settingsUrl(item))}>{t('settings')}</button>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

<section class="panel narrow overlay" aria-labelledby="overlay-about">
  <h2 id="overlay-about">{t('overlay_heading')}</h2>
  <p class="lead">{t('overlay_lead')}</p>
  <p class="check">
    <label
      ><input
        type="checkbox"
        bind:checked={enabled}
        disabled={saving || !loaded}
        onchange={save}
        aria-describedby="overlay-about"
      />
      {t('overlay_enable')}</label
    >
  </p>
  {#if saving}<p role="status">{t('saving')}</p>{/if}
  {#if failure}<p class="failed" role="alert">{failure}</p>{/if}
  {#if savedMessage && !failure}<p class="muted" role="status">{savedMessage}</p>{/if}
</section>

{#if enabled}
  <section class="panel narrow overlay" aria-labelledby="overlay-windows">
    <h2 id="overlay-windows">{t('overlay_windows_heading')}</h2>
    <p class="hint">{t('overlay_windows_hint')}</p>
    {#if windowsFailure}<p class="failed" role="alert">{windowsFailure}</p>{/if}
    {#if windows === null && !windowsFailure}
      <p role="status">{t('loading')}</p>
    {:else if windows}
      {@render list(groups.builtin)}
      {#if groups.mods.length > 0}
        <h3>{t('overlay_mod_windows')}</h3>
        {@render list(groups.mods)}
      {/if}
    {/if}
    <p class="hint"><a href="/pages/mods.html" target="_blank" rel="noopener">{t('overlay_manage_mods')}</a></p>
  </section>
{/if}

<style>
  .panel {
    max-width: 34rem;
    padding: 1.25rem;
    margin: 0 0 1rem;
    border-radius: 12px;
    background: var(--glass);
  }
  .lead {
    margin: 0 0 1rem;
  }
  .hint {
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
  }
  input[type='checkbox'] {
    width: auto;
    margin: 0;
  }
  .check label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  h3 {
    margin: 1.2rem 0 0.6rem;
  }
  .windows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .windows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.9rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    background: var(--well);
  }
  .windows .line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .windows .name {
    font-weight: 600;
  }
  .windows .detail {
    flex: 1 1 14rem;
    color: var(--muted);
  }
  .windows .actions {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }
  .failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
    padding-left: 0.75rem;
  }
</style>
