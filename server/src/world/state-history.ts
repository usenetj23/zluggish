import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';

const ghostPlayerField = 1;
const ghostStatesField = 2;

/**
A rider's ride history, kept as encoded states. A decoded PlayerState costs about 15x its wire size,
and a history holds up to `limit` samples for every rider who rode since the last restart.
*/
export class StateHistory {
  private encoded: Array<Uint8Array> = [];

  private times: Array<bigint> = [];

  constructor(readonly limit = 14_400) {}

  get length() {
    return this.encoded.length;
  }

  push(state: PlayerState) {
    this.encoded.push(toBinary(PlayerStateSchema, state));
    this.times.push(state.worldTime);

    if (this.encoded.length <= this.limit) {
      return;
    }
    this.encoded.shift();
    this.times.shift();
  }

  prepend(states: ReadonlyArray<PlayerState>) {
    this.encoded = [...states.map((state) => toBinary(PlayerStateSchema, state)), ...this.encoded].slice(-this.limit);
    this.times = [...states.map((state) => state.worldTime), ...this.times].slice(-this.limit);
  }

  worldTime(index: number) {
    return this.times.at(index);
  }

  state(index: number) {
    const bytes = this.encoded.at(index);

    return bytes ? fromBinary(PlayerStateSchema, bytes) : undefined;
  }

  states() {
    return this.encoded.map((bytes) => fromBinary(PlayerStateSchema, bytes));
  }

  since(worldTime: bigint) {
    return this.encoded.filter((_, index) => (this.times[index] ?? 0n) > worldTime);
  }

  /** The history as a Ghost recording, without decoding it. */
  ghost(playerId: number) {
    const writer = new BinaryWriter().tag(ghostPlayerField, WireType.Varint).int32(playerId);

    for (const bytes of this.encoded) {
      writer.tag(ghostStatesField, WireType.LengthDelimited).bytes(bytes);
    }

    return writer.finish();
  }
}
