<script lang="ts">
  import { onMount } from 'svelte';

  type Climb = { road: string; name: string; rides: number; bestMs: number | null; lastRide: string | null };

  let {
    api,
  }: {
    api: <Body>(url: string) => Promise<Body>;
  } = $props();

  let climbs = $state<Climb[] | null>(null);
  let failure = $state('');

  const ridden = (climb: Climb) => (climb.lastRide ? Date.parse(climb.lastRide) : Number.NEGATIVE_INFINITY);

  /** The most recently ridden climb first. */
  const ordered = $derived([...(climbs ?? [])].sort((a, b) => ridden(b) - ridden(a)));

  const clock = (ms: number | null) => {
    if (ms === null) return '–';

    const s = Math.round(ms / 1000);
    const seconds = String(s % 60).padStart(2, '0');

    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${seconds}`
      : `${Math.floor(s / 60)}:${seconds}`;
  };

  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '–';

  onMount(async () => {
    try {
      climbs = (await api<{ climbs: Climb[] }>('/api/me/climbs')).climbs;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Climbs could not be loaded.';
    }
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
{#if climbs === null}
  {#if !failure}<p class="delayed" role="status">Loading climbs…</p>{/if}
{:else if climbs.length === 0}
  <section class="panel narrow">
    <p>
      No climb portals ridden yet. Climbs you ride in the game appear here, with your best time and your latest ride.
    </p>
  </section>
{:else}
  <section class="panel" aria-labelledby="climbs-title">
    <h2 id="climbs-title">Climb portals ridden: {climbs.length}</h2>
    <table class="climbs">
      <thead>
        <tr>
          <th scope="col">Climb</th>
          <th scope="col">Rides</th>
          <th scope="col">Best time</th>
          <th scope="col">Last ride</th>
        </tr>
      </thead>
      <tbody>
        {#each ordered as climb (climb.road)}
          <tr>
            <th scope="row">{climb.name}</th>
            <td>{climb.rides}</td>
            <td>{clock(climb.bestMs)}</td>
            <td>{day(climb.lastRide)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<style>
  .delayed {
    animation: reveal 150ms ease-out 400ms both;
  }
  @keyframes reveal {
    from {
      opacity: 0;
      visibility: hidden;
    }
  }

  .climbs {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .climbs th,
  .climbs td {
    padding: 0.5rem 0.5rem 0.5rem 0;
    border-bottom: 1px solid var(--line);
    text-align: right;
    font-weight: 700;
    white-space: nowrap;
  }
  .climbs thead th {
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .climbs th:first-child {
    text-align: left;
    white-space: normal;
  }
  .climbs tbody th {
    font-weight: 600;
  }
  .climbs tbody td:nth-child(3) {
    font-weight: 800;
  }
</style>
