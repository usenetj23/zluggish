<script lang="ts">
  import { onMount } from 'svelte';
  import { clock, day, providerLabel, statLabels, type Climb, type ClimbRide } from './climbs';
  import ClimbProfile from './ClimbProfile.svelte';

  let {
    climb,
    api,
  }: {
    climb: Climb;
    api: <Body>(url: string) => Promise<Body>;
  } = $props();

  let rides = $state<ClimbRide[]>([]);
  let ridesLoading = $state(true);
  let ridesError = $state('');

  onMount(async () => {
    try {
      const body = await api<{ rides: ClimbRide[] }>(`/api/me/climbs/${climb.road}/rides`);
      rides = body.rides;
    } catch (error) {
      ridesError = error instanceof Error ? error.message : 'Rides could not be loaded.';
    } finally {
      ridesLoading = false;
    }
  });
</script>

<div class="detail">
  <dl class="facts">
    {#if climb.distanceKm !== null}
      <dt>Distance</dt>
      <dd>{climb.distanceKm} km</dd>
    {/if}
    {#if climb.elevationM !== null}
      <dt>Climbing</dt>
      <dd>{climb.elevationM} m</dd>
    {/if}
    {#if climb.avgGradePct !== null}
      <dt>Average grade</dt>
      <dd>{climb.avgGradePct.toFixed(1)}%</dd>
    {/if}
    {#if climb.maxGradePct !== null}
      <dt>Max grade</dt>
      <dd>{climb.maxGradePct.toFixed(1)}%</dd>
    {/if}
    <dt>Category</dt>
    <dd>{climb.category ?? 'None'}</dd>
    {#if climb.elevationLowM !== null}
      <dt>Lowest</dt>
      <dd>{climb.elevationLowM} m</dd>
    {/if}
    {#if climb.elevationHighM !== null}
      <dt>Highest</dt>
      <dd>{climb.elevationHighM} m</dd>
    {/if}
  </dl>

  <ClimbProfile points={climb.profile} label={`Elevation profile of ${climb.name}`} />

  <p class="source" class:imported={climb.profileSource === 'imported'}>
    {climb.profileSource === 'imported'
      ? 'Profile from your recorded ride'
      : 'Straight-line estimate, no recorded profile yet'}
  </p>

  <section class="rides">
    <h4>Your rides</h4>

    {#if ridesLoading}
      <p role="status">Loading rides…</p>
    {:else if ridesError}
      <p role="alert">{ridesError}</p>
    {:else if rides.length === 0}
      <p>No rides yet.</p>
    {:else}
      <ul class="ride-list">
        {#each rides as ride, rideIndex (rideIndex)}
          <li>
            <span class="ride-date">{ride.rideAt ? day(ride.rideAt) : 'Unknown date'}</span>
            <span class="ride-time">{ride.elapsedMs !== null ? clock(ride.elapsedMs) : 'No time'}</span>
            {#if ride.stats !== null}
              {#each statLabels(ride.stats) as label, i (i)}
                <span class="ride-stat">{label}</span>
              {/each}
            {/if}
            {#if ride.links.length > 0}
              <span class="ride-links">
                {#each ride.links as link (link.provider)}
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="{providerLabel(link.provider)} activity of {ride.rideAt
                      ? day(ride.rideAt)
                      : 'Unknown date'}">{providerLabel(link.provider)}</a
                  >
                {/each}
              </span>
            {:else if ride.stats !== null}
              <span class="muted">Recorded ride</span>
            {:else}
              <span class="muted">No activity link</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .detail {
    padding: 1rem 0 0.5rem;
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 1rem;
    margin: 0 0 1rem;
    font-size: 0.875rem;
  }
  .facts dt {
    color: var(--muted);
    font-weight: 600;
  }
  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .source {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .source.imported {
    color: #6a9955;
  }

  .rides {
    margin-top: 1rem;
  }
  .rides h4 {
    margin: 0 0 0.5rem;
    font-size: 0.9375rem;
  }

  .ride-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ride-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
    font-size: 0.875rem;
  }
  .ride-list li:last-child {
    border-bottom: 0;
  }

  .ride-date {
    font-weight: 600;
    min-width: 7rem;
  }
  .ride-time {
    font-variant-numeric: tabular-nums;
    min-width: 5rem;
  }
  .ride-stat {
    font-size: 0.8125rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .ride-links {
    display: flex;
    gap: 0.5rem;
  }
  .ride-links a {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 6px;
    background: var(--glass);
    font-size: 0.8125rem;
    text-decoration: none;
    color: inherit;
  }
  .ride-links a:hover {
    text-decoration: underline;
  }

  .muted {
    color: var(--muted);
    font-style: italic;
  }

  @media (max-width: 44rem) {
    .ride-list li {
      flex-direction: column;
      gap: 0.25rem;
    }
    .ride-date,
    .ride-time {
      min-width: 0;
    }
  }
</style>
