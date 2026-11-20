export type ClimbCategory = 'HC' | '1' | '2' | '3' | '4';

export type Climb = {
  road: string;
  name: string;
  distanceKm: number | null;
  elevationM: number | null;
  rides: number;
  bestMs: number | null;
  lastRide: string | null;
  strava: { watopia: number; france: number } | null;
  category: ClimbCategory | null;
  avgGradePct: number | null;
  maxGradePct: number | null;
  elevationLowM: number | null;
  elevationHighM: number | null;
  profile: Array<[number, number]>;
  profileSource: 'imported' | 'estimated';
};

export const categoryTabs = ['all', 'HC', '1', '2', '3', '4', 'none'] as const;

export type CategoryTab = (typeof categoryTabs)[number];

export const tabOf = (value: string | null): CategoryTab => categoryTabs.find((tab) => tab === value) ?? 'all';

export const matchesTab = (climb: Climb, tab: CategoryTab): boolean => {
  if (tab === 'all') return true;

  if (tab === 'none') return climb.category === null;

  return climb.category === tab;
};

export const gradeBand = (gradePct: number): 'flat' | 'easy' | 'steady' | 'steep' => {
  if (gradePct < 3) return 'flat';

  if (gradePct < 6) return 'easy';

  if (gradePct < 9) return 'steady';

  return 'steep';
};

export const clock = (ms: number): string => {
  const s = Math.round(ms / 1000);
  const seconds = String(s % 60).padStart(2, '0');

  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${seconds}`
    : `${Math.floor(s / 60)}:${seconds}`;
};

export const day = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
