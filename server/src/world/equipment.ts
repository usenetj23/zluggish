import { Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const gameInfo = Schema.Struct({
  bikeFrames: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }))),
});

/** One entry of an athlete's equipment: an id known to the game and, when we know it, its name. */
export interface EquipmentItem {
  id: number;
  name: string | null;
}

/** The equipment Sauce adds to athlete objects in Zwift 2.4. */
export interface Equipment {
  cycling?: { frame: EquipmentItem; wheelFront: EquipmentItem; wheelRear: EquipmentItem };
  running?: { shoes: EquipmentItem };
}

/** Names of the bike frames by frame id, from data/game_info.txt; a missing or malformed file gives an empty map. */
export function loadBikeFrameNames(assets: string): Map<number, string> {
  const names = new Map<number, string>();

  try {
    const text = readFileSync(resolve(assets, 'data/game_info.txt'), 'utf8').replace(/^\u{FEFF}/u, '');

    for (const frame of Schema.decodeUnknownSync(gameInfo)(JSON.parse(text)).bikeFrames ?? []) {
      if (frame.name) {
        names.set(frame.id, frame.name);
      }
    }
  } catch {
    // no game info, no names
  }

  return names;
}

/** The equipment of a player profile: undefined and 0 mean 'not set', so only the parts that apply are present. */
export function equipmentOf(
  profile: { bikeFrame?: number; bikeWheelFront?: number; bikeWheelRear?: number; runShoesType?: number },
  frames: ReadonlyMap<number, string>,
): Equipment {
  const equipment: Equipment = {};

  if (profile.bikeFrame) {
    equipment.cycling = {
      frame: { id: profile.bikeFrame, name: frames.get(profile.bikeFrame) ?? null },
      wheelFront: { id: profile.bikeWheelFront ?? 0, name: null },
      wheelRear: { id: profile.bikeWheelRear ?? 0, name: null },
    };
  }

  if (profile.runShoesType) {
    equipment.running = { shoes: { id: profile.runShoesType, name: null } };
  }

  return equipment;
}
