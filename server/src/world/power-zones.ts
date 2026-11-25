/**
The power zones of a rider, in the convention of the Sauce for Zwift widget pages: `from` is exclusive
and `to` is inclusive, the identifiers are `Z1`...`Z7` and the boundaries are multiples of the FTP, so
the very same numbers `cogganZones` of `assets/sauce/shared/sauce/power.mjs` hands out. Plain arithmetic
on one number, with no access to the world or to a profile, so the same zones can be checked in a test.

The names are the default power zone names of Intervals.icu.
*/

/** One power zone: an identifier, a name and the watts it covers. */
export interface PowerZone {
  zone: string;

  name: string;

  /** exclusive lower bound, in watts. */
  from: number;

  /** inclusive upper bound, in watts; null for the highest zone, which has no ceiling. */
  to: number | null;

  /** true for a zone that lies over the others (the sweet spot): it is counted next to the zone a reading is in. */
  overlap?: boolean;
}

/** The zone model the app settings choose between. */
export type ZonesType = 'coggan' | 'polarized';

/** The sweet spot band: Coggan's 88-93 % or FasCat's 84-97 % of FTP; null for none. */
export type SweetspotType = 'coggan' | 'fascat' | null;

export interface ZoneSettings {
  type: ZonesType;
  sweetspot: SweetspotType;
}

/** The share of FTP each zone reaches up to, with its identifier and name; `to` is null for the last. */
const spans: Array<PowerZone> = [
  { zone: 'Z1', name: 'Active Recovery', from: 0, to: 0.55 },
  { zone: 'Z2', name: 'Endurance', from: 0.55, to: 0.75 },
  { zone: 'Z3', name: 'Tempo', from: 0.75, to: 0.9 },
  { zone: 'Z4', name: 'Threshold', from: 0.9, to: 1.05 },
  { zone: 'Z5', name: 'VO2 Max', from: 1.05, to: 1.2 },
  { zone: 'Z6', name: 'Anaerobic', from: 1.2, to: 1.5 },
  { zone: 'Z7', name: 'Neuromuscular', from: 1.5, to: null },
];

const polarizedSpans: Array<PowerZone> = [
  { zone: 'Z1', name: 'Low Intensity', from: 0.4, to: 0.8 },
  { zone: 'Z2', name: 'Moderate Intensity', from: 0.8, to: 1 },
  { zone: 'Z3', name: 'High Intensity', from: 1, to: null },
];

const sweetspotRanges: Record<'coggan' | 'fascat', [number, number]> = {
  coggan: [0.88, 0.93],
  fascat: [0.84, 0.97],
};

/*
The zones every screen and every statistic of this server uses are one setting of the whole app (see
`world/app-settings`), read here instead of being handed through every call: the zone times of a rider are
folded with it, `getPowerZones` answers with it. `zonesRevision` changes with the setting, so what was
folded with an older one is replayed.
*/
let current: ZoneSettings = { type: 'coggan', sweetspot: null };
let revision = 0;

/** Chooses the zone model; a change of either part bumps the revision. */
export function configureZones(next: ZoneSettings): void {
  if (next.type === current.type && next.sweetspot === current.sweetspot) {
    return;
  }

  current = { type: next.type, sweetspot: next.sweetspot };
  revision += 1;
}

/** A number that changes whenever the chosen zone model does. */
export function zonesRevision(): number {
  return revision;
}

/**
The power zones of one FTP in the model the app settings chose (Coggan's seven by default), followed by
the sweet spot band when one is chosen. Sauce pages ask for them with `getPowerZones(1)` and multiply
themselves, so a FTP that is not a finite number above zero falls back to 1 and the boundaries stay the
fractions of FTP; nothing is rounded, the products are handed over as they come out of the multiplication.
*/
export function powerZones(ftp: number): Array<PowerZone> {
  const base = Number.isFinite(ftp) && ftp > 0 ? ftp : 1;

  const model = current.type === 'polarized' ? polarizedSpans : spans;
  const zones: Array<PowerZone> = model.map(({ zone, name, from, to }) => ({
    zone,
    name,
    from: base * from,
    to: to === null ? null : base * to,
  }));

  if (current.sweetspot !== null) {
    const [low, high] = sweetspotRanges[current.sweetspot];

    zones.push({ zone: 'SS', name: 'Sweet Spot', from: base * low, to: base * high, overlap: true });
  }

  return zones;
}
