import type { PlanBlock } from '#src/world/zwo';

/** Where every block of a plan starts, in seconds from the start of the workout. */
export function stepStarts(blocks: readonly PlanBlock[]) {
  let start = 0;

  return blocks.map((block) => {
    const at = start;

    start += block.durationSeconds ?? 0;

    return at;
  });
}

/** The target of a block as a share of FTP `elapsedS` seconds into it: a ramp is read along its length. */
export function powerRatio(block: PlanBlock, elapsedS: number) {
  if (block.power?.format !== 'ftp') return null;

  const { low, high } = block.power;
  const duration = block.durationSeconds ?? 0;
  const progress = duration > 0 ? Math.min(1, Math.max(0, elapsedS / duration)) : 0;

  return (low + (high - low) * progress) / 100;
}

/**
How far into a ramp the screen is when it asks for these watts: the seconds that put the ramp at that target, or null
when the block is not a ramp or the target lies outside it. The game raises a ramp in small steps, so every step says
where the workout really is, whatever a pause did to the clock.
*/
export function rampProgress(block: PlanBlock, ftp: number, watts: number) {
  if (block.power?.format !== 'ftp' || ftp <= 0) return null;

  const { low, high } = block.power;
  const duration = block.durationSeconds ?? 0;

  if (high <= low || duration <= 0) return null;

  const share = (watts / ftp) * 100;
  const tolerance = (high - low) * 0.05;

  if (share < low - tolerance || share > high + tolerance) return null;

  return Math.min(1, Math.max(0, (share - low) / (high - low))) * duration;
}
