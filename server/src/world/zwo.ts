import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** One flattened block of a .zwo plan, as the game shows it during a workout. */
export interface PlanBlock {
  name: string;
  durationSeconds: number | null;
  meters: number | null;
  /** Target power; `format: 'ftp'` means percent of FTP; null is free power. */
  power: { format: 'watts' | 'ftp'; low: number; high: number } | null;
  cadence: number | null;
}

export interface WorkoutPlan {
  name: string;
  blocks: PlanBlock[];
  totalSeconds: number;
}

/** The most blocks of one plan and the longest block: a plan beyond them is not a workout somebody rides. */
const MAX_BLOCKS = 2000;
const MAX_BLOCK_SECONDS = 86_400;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

const num = (value: string | undefined): number | null => {
  const result = Number(value);

  return value !== undefined && value !== '' && Number.isFinite(result) && result >= 0 ? result : null;
};

const list = <Item>(value: Item | Item[] | undefined): Item[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

interface RawSection {
  '@_name'?: string;
  '@_repeats'?: string;
  Block?: RawBlock | RawBlock[];
}

interface RawBlock {
  '@_type'?: string;
  '@_time'?: string;
  '@_distance'?: string;
  '@_targetPowerWatts'?: string;
  '@_lowWatts'?: string;
  '@_highWatts'?: string;
  '@_targetPowerPct'?: string;
  '@_lowPct'?: string;
  '@_highPct'?: string;
  '@_cadence'?: string;
}

/** Power of one block: watts win over percents, a lone target is a steady level. */
function blockPower(block: RawBlock): PlanBlock['power'] {
  const watts = [num(block['@_targetPowerWatts']), num(block['@_lowWatts']), num(block['@_highWatts'])];

  if (watts.some((value) => value !== null && value > 0)) {
    const low = watts[1] ?? watts[0] ?? 0;
    const high = watts[2] ?? watts[0] ?? 0;

    return { format: 'watts', low, high };
  }

  const percents = [num(block['@_targetPowerPct']), num(block['@_lowPct']), num(block['@_highPct'])];

  if (percents.some((value) => value !== null)) {
    const low = percents[1] ?? percents[0] ?? 0;
    const high = percents[2] ?? percents[0] ?? 0;

    return { format: 'ftp', low, high };
  }

  return null;
}

/**
A .zwo workout file as a flat list of blocks. Sections repeat through their
`repeats` attribute the same way the game numbers one block per repetition;
lap blocks are skipped. A plan with no blocks at all comes back null.
*/
export function parsePlan(content: string): WorkoutPlan | null {
  if (content.length > 16 * 1024 * 1024 || XMLValidator.validate(content) !== true) return null;

  // SAFETY: the content is valid XML, so the parser returns an object; every field is read through optional access.
  const file = (parser.parse(content) as { workoutFile?: { Name?: string; Sections?: { Section?: RawSection } } })
    .workoutFile;

  if (!file) return null;

  const blocks: PlanBlock[] = [];

  for (const section of list(file.Sections?.Section)) {
    const name = section['@_name'] ?? '';
    const repeats = Math.max(1, Math.trunc(num(section['@_repeats']) ?? 1));

    for (let repeat = 0; repeat < repeats; repeat += 1)
      for (const block of list(section.Block)) {
        if (block['@_type'] === 'lap') continue;

        // A file from a third party must not make the plan, or the timers made from it, unbounded.
        if (blocks.length >= MAX_BLOCKS) return null;

        const rawSeconds = num(block['@_time']);
        const seconds = rawSeconds === null ? null : Math.min(rawSeconds, MAX_BLOCK_SECONDS);
        const meters = num(block['@_distance']);
        const power = blockPower(block);

        blocks.push({
          name: repeats > 1 ? `${name} ${repeat + 1}/${repeats}` : name,
          durationSeconds: seconds !== null && seconds > 0 ? seconds : null,
          meters,
          power: power !== null && power.low === 0 && power.high === 0 ? null : power,
          cadence: num(block['@_cadence']),
        });
      }
  }

  if (blocks.length === 0) return null;

  return {
    name: file.Name ?? '',
    blocks,
    totalSeconds: blocks.reduce((total, b) => total + (b.durationSeconds ?? 0), 0),
  };
}
