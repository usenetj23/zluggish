<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import { onMount } from 'svelte';
  import { z } from 'zod';
  import type { Api } from '../lib/api';

  const climbSchema = z.object({
    road: z.string(),
    name: z.string(),
    distanceKm: z.number().nullable(),
    elevationM: z.number().nullable(),
    rides: z.number(),
    bestMs: z.number().nullable(),
    lastRide: z.string().nullable(),
    /** The two Strava segments of the climb, as ridden from Watopia and from France. */
    strava: z.object({ watopia: z.number(), france: z.number() }).nullable(),
  });

  type Climb = z.infer<typeof climbSchema>;

  const climbsResponse = z.object({ climbs: z.array(climbSchema), total: z.number() });

  const segment = (id: number) => `https://www.strava.com/segments/${id}`;

  let {
    api,
  }: {
    api: Api;
  } = $props();

  let climbs = $state<Array<Climb> | null>(null);
  let total = $state(0);
  let failure = $state('');

  const ridden = (climb: Climb) => (climb.lastRide ? Date.parse(climb.lastRide) : Number.NEGATIVE_INFINITY);

  const ordered = $derived([...(climbs ?? [])].sort((a, b) => ridden(b) - ridden(a)));
  const rides = $derived((climbs ?? []).reduce((sum, climb) => sum + climb.rides, 0));

  const gradient = (climb: Climb) =>
    climb.distanceKm && climb.elevationM !== null ? climb.elevationM / (climb.distanceKm * 10) : null;

  const clock = (ms: number) => {
    const s = Math.round(ms / 1000);
    const seconds = String(s % 60).padStart(2, '0');

    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${seconds}`
      : `${Math.floor(s / 60)}:${seconds}`;
  };

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

  const plural = (count: number) => t('ride_count', { value1: count, value2: count === 1 ? t('ride') : t('rides') });

  onMount(async () => {
    try {
      const body = await api(climbsResponse, '/api/me/climbs');
      total = body.total;
      climbs = body.climbs;
    } catch (error) {
      failure = error instanceof Error ? error.message : t('climbs_load_error');
    }
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
{#if climbs === null}
  {#if !failure}<SlowLoading />{/if}
{:else if climbs.length === 0}
  <section class="panel narrow">
    <h2>{t('climbs_empty')}</h2>
    <p>
      {t('climbs_empty_hint_prefix')} <strong>{t('climb')}</strong>
      {t('climbs_empty_hint_suffix')}
    </p>
  </section>
{:else}
  <section class="climbs" aria-label={t('climb_portals')}>
    <ul class="panel">
      {#each ordered as climb (climb.road)}
        {@const grade = gradient(climb)}
        <li>
          <p class="height">
            {#if climb.elevationM !== null}
              <strong
                >{t('m', { value1: climb.elevationM.toLocaleString() })}<span class="hidden">
                  {t('climbing')}</span
                ></strong
              >
            {/if}
          </p>

          <div class="name">
            <h3>{climb.name}</h3>
            {#if climb.distanceKm !== null && grade !== null}
              <p>{t('km_at', { value1: climb.distanceKm, value2: grade.toFixed(1) })}</p>
            {/if}
          </div>

          <p class="best">
            {#if climb.bestMs !== null}
              <strong>{clock(climb.bestMs)}</strong>
              <span>{t('best_of', { value1: climb.rides })}</span>
            {:else}
              <strong class="none">{t('no_time')}</strong>
            {/if}
          </p>

          <p class="last">
            {#if climb.lastRide}
              <strong><time datetime={climb.lastRide}>{day(climb.lastRide)}</time></strong>
              <span>{t('last_ride')}</span>
            {/if}
          </p>

          {#if climb.strava}
            <p class="strava">
              <span class="links">
                <a
                  href={segment(climb.strava.watopia)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="{climb.name} on Strava, ridden from Watopia">{t('watopia')}</a
                >
                <a
                  href={segment(climb.strava.france)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="{climb.name} on Strava, ridden from France">{t('france')}</a
                >
              </span>
              <span>{t('strava_link_suffix')}</span>
            </p>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="summary">
      {t('of_climb_portals_ridden', { value1: climbs.length, value2: total, value3: plural(rides) })}
    </p>
  </section>
{/if}

<style>
  /* Styles are scoped per component, so the glass panel of the other pages is repeated here. */
  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .narrow {
    max-width: 34rem;
  }
  .narrow p {
    margin-bottom: 0;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
    padding-left: 0.75rem;
  }

  .climbs ul {
    list-style: none;
    margin: 0;
    padding-block: 0.25rem;
  }
  .summary {
    margin: 0.75rem 0 0;
    padding-inline: 0.25rem;
    color: var(--muted);
  }

  .climbs li {
    display: grid;
    grid-template-columns: 8.5rem minmax(0, 1fr) 7rem 8.5rem 8.5rem;
    grid-template-areas: 'height name best last strava';
    align-items: center;
    gap: 0.5rem 1.25rem;
    padding: 0.85rem 0;
    border-bottom: 1px solid var(--line);
  }
  .climbs li:last-child {
    border-bottom: 0;
  }

  /* The height is the number a climber looks for first, so it is the largest figure in the row. */
  .height {
    grid-area: height;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin: 0;
    padding-right: 1.25rem;
    border-right: 3px solid var(--orange);
    white-space: nowrap;
  }
  .height strong {
    font-size: 1.5rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .name {
    grid-area: name;
    min-width: 0;
  }
  .name h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 800;
    line-height: 1.25;
  }
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .name p,
  .best span,
  .last span,
  .strava > span:last-child {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .best,
  .last,
  .strava {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin: 0;
    text-align: right;
    white-space: nowrap;
  }
  .best {
    grid-area: best;
  }
  .best strong {
    font-size: 1.125rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1.25;
  }
  .best .none {
    font-size: 0.9375rem;
    color: var(--muted);
  }
  .last {
    grid-area: last;
  }
  .last strong {
    font-weight: 800;
    line-height: 1.45;
  }
  .strava {
    grid-area: strava;
  }
  .strava .links {
    display: flex;
    gap: 0.75rem;
    line-height: 1.45;
  }

  @media (max-width: 44rem) {
    .climbs li {
      grid-template-columns: 4.5rem minmax(0, 1fr) auto;
      grid-template-areas:
        'height name best'
        'height last last'
        'height strava strava';
      align-items: start;
      gap: 0.35rem 0.75rem;
    }
    .height {
      align-self: stretch;
      padding-right: 0.6rem;
    }
    .height strong {
      font-size: 1rem;
    }
    .last,
    .strava {
      flex-direction: row;
      align-items: baseline;
      gap: 0.5rem;
      text-align: left;
    }
    .last strong {
      font-weight: 600;
    }
  }
</style>
