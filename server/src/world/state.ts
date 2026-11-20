import type { PlayerState, ServerToClient, WorldAttribute } from '#src/protocol/generated/udp-node-msgs_pb';
import { PlayerStateSchema, ServerToClientSchema, WA_TYPE } from '#src/protocol/generated/udp-node-msgs_pb';
import { SocialPlayerActionSchema, SocialPlayerActionType } from '#src/protocol/generated/tcp-node-msgs_pb';
import { Lifecycle } from '#src/world/lifecycle';
import type { Simulation } from '#src/world/simulation';
import { StateHistory } from '#src/world/state-history';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';

/** Zwift world time counts milliseconds from this Unix time. */
export const WORLD_TIME_EPOCH_MS = 1_414_016_075_000;

export function worldTime() {
  return BigInt(Date.now() - WORLD_TIME_EPOCH_MS);
}

export function course(state: PlayerState) {
  return (state.f19 & 0xff_00_00) >>> 16;
}

export function road(state: PlayerState) {
  return (state.aux3 >>> 8) & 0xff_ff;
}

export function forward(state: PlayerState) {
  return (state.f19 & 4) !== 0;
}

/** Per authenticated relay; only accepted packets advance counters. Never an anti-replay policy. */
export class Relay {
  tcpConnection = 0;

  udpConnection = 0;

  tcpRead = 0;

  tcpWrite = 0;

  udpRead = 0;

  udpWrite = 0;

  constructor(readonly key: Buffer) {}

  acceptUdp(connection: number, explicitConnection?: number, sequence?: number) {
    if (explicitConnection !== undefined && explicitConnection !== this.udpConnection) this.udpWrite = 0;
    this.udpConnection = connection;
    this.udpRead = sequence ?? this.udpRead + 1;
  }

  acceptTcp(connection: number, hello: boolean) {
    if (hello) {
      this.tcpConnection = connection;
      this.tcpRead = 1;
      this.tcpWrite = 0;
    } else this.tcpRead++;
  }

  nextUdp() {
    return this.udpWrite++;
  }

  nextTcp() {
    return this.tcpWrite++;
  }
}

/** Encoded size of a `ServerToClient.states` entry (field 8): one tag byte, a varint length, then the state. */
function embeddedSize(length: number) {
  let prefix = 1;

  for (let rest = length; rest >= 0x80; rest >>>= 7) prefix++;

  return 1 + prefix + length;
}

export function fresh(state: PlayerState, now = worldTime()) {
  return now < state.worldTime + 10_000n;
}

export function expired(state: PlayerState, now = worldTime()) {
  return now > state.worldTime + 30_000n;
}

/** Presence is online-map membership plus freshness, independent of relay/socket and observed ride. */
export class World {
  readonly lifecycle = new Lifecycle();

  presence: ((id: bigint, joining: boolean) => void) | undefined;

  disconnect: ((id: bigint) => void) | undefined;

  simulation: Simulation | undefined;

  /** Ride recovery follows each session start and end. */
  sessions: { login: (id: bigint) => void; logout: (id: bigint, reason: string) => void } | undefined;

  /** Every chat bubble of the game, copied to the voice service to be read aloud. */
  chatObserver:
    | ((update: { playerId: bigint; from: string; text: string }, recipients: readonly bigint[]) => void)
    | undefined;

  readonly personal = new Map<bigint, Map<bigint, PlayerState>>();

  readonly phones = new Map<bigint, ServerToClient>();

  readonly news = new Map<bigint, Map<bigint, bigint>>();

  readonly online = new Map<bigint, PlayerState>();

  readonly relays = new Map<bigint, Relay>();

  readonly updates = new Map<bigint, WorldAttribute[]>();

  readonly mapOverrides = new Map<string, string>();

  readonly climbOverrides = new Map<string, string>();

  readonly synthetic = new Map<bigint, PlayerState>();

  readonly histories = new Map<bigint, StateHistory>();

  private readonly generations = new Map<bigint, number>();

  /** Each login and logout starts a new session generation; stale loads compare it. */
  generation(playerId: bigint) {
    return this.generations.get(playerId) ?? 0;
  }

  private advance(playerId: bigint) {
    this.generations.set(playerId, this.generation(playerId) + 1);
  }

  active(playerId: number | bigint) {
    const state = this.online.get(BigInt(playerId));

    return !!state && fresh(state);
  }

  login(playerId: bigint, key: Uint8Array) {
    if (![16, 24, 32].includes(key.length)) throw new Error('Invalid relay key');

    const relay = new Relay(Buffer.from(key));

    this.relays.set(playerId, relay);
    this.histories.delete(playerId);
    this.advance(playerId);
    this.sessions?.login(playerId);

    return relay;
  }

  logout(playerId: bigint, reason = 'logout') {
    this.disconnect?.(playerId);
    this.advance(playerId);
    this.sessions?.logout(playerId, reason);
    this.lifecycle.end(playerId, reason);
    this.simulation?.logout(playerId);
    const wasOnline = this.online.delete(playerId);

    if (wasOnline) this.presence?.(playerId, false);
    this.relays.delete(playerId);
    this.updates.delete(playerId);
    this.news.delete(playerId);
    this.personal.delete(playerId);
    this.phones.delete(playerId);
  }

  receive(playerId: bigint, state: PlayerState) {
    if (state.id && state.id !== playerId) throw new Error('State identity does not match relay');
    const previous = this.online.get(playerId);

    if (previous && previous.worldTime > state.worldTime) return;

    if (!(state.roadTime && (previous || fresh(state)))) return;

    const snapshot = clone(PlayerStateSchema, state);
    snapshot.id = playerId;
    this.online.set(playerId, snapshot);
    this.lifecycle.receive(playerId, snapshot.distance, course(snapshot), BigInt(snapshot.route), snapshot.sport);

    if (!previous) this.presence?.(playerId, true);
    this.simulation?.receive(playerId, snapshot);
    const history = this.histories.get(playerId) ?? new StateHistory();

    if (history.length === 0 || Number(snapshot.worldTime - (history.worldTime(-1) ?? 0n)) >= 3000)
      history.push(snapshot);

    this.histories.set(playerId, history);
  }

  // Queue admission is bounded; the TCP owner takes/deletes a batch before sending.
  // nearby separately checkpoints each peer timestamp, suppressing unchanged snapshots.
  enqueue(update: WorldAttribute, recipients: bigint[] = this.online.keys().toArray()) {
    if (this.chatObserver && update.waType === WA_TYPE.WAT_SPA) {
      try {
        const action = fromBinary(SocialPlayerActionSchema, update.payload);

        if (action.spaType === SocialPlayerActionType.SOCIAL_TEXT_MESSAGE)
          this.chatObserver(
            { playerId: action.playerId, from: `${action.firstName} ${action.lastName}`.trim(), text: action.message },
            recipients,
          );
      } catch {
        /* Not a chat bubble. */
      }
    }

    for (const id of recipients) {
      const queue = this.updates.get(id) ?? [];

      if (queue.length >= 1000) queue.shift();

      queue.push(update);
      this.updates.set(id, queue);
    }
  }

  nearby(playerId: bigint, state: PlayerState) {
    const personal = this.personal.get(playerId) ?? new Map<bigint, PlayerState>();

    const watching =
      this.online.get(state.watchingRiderId) ??
      this.synthetic.get(state.watchingRiderId) ??
      personal.get(state.watchingRiderId) ??
      state;

    const candidates = [];
    const news = this.news.get(playerId) ?? new Map<bigint, bigint>();
    this.news.set(playerId, news);

    for (const [id, peer] of [...this.online, ...this.synthetic, ...personal]) {
      if (id === playerId || course(watching) !== course(peer)) continue;

      if (this.online.has(id) && !fresh(peer)) continue;

      if (news.get(id) === peer.worldTime) continue;

      const distance = Math.hypot(peer.x - watching.x, peer.z - watching.z, peer.yAltitude - watching.yAltitude);

      if (distance <= 100_000 || road(peer) === road(watching)) candidates.push({ peer, distance });
    }

    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 100)
      .map((item) => {
        news.set(item.peer.id, item.peer.worldTime);

        return item.peer;
      });
  }

  responses(playerId: bigint, state: PlayerState, clientTime: bigint) {
    const packets = [];

    let message = create(ServerToClientSchema, {
      serverRealm: 1n,
      playerId,
      worldTime: worldTime(),
      ctsLatency: worldTime() - clientTime,
    });

    // Track the encoded size instead of re-encoding the growing packet for each peer.
    let size = toBinary(ServerToClientSchema, message).length;

    for (const peer of this.nearby(playerId, state)) {
      const length = toBinary(PlayerStateSchema, peer).length;

      if (size + length > 1400) {
        packets.push(message);
        message = create(ServerToClientSchema, {
          serverRealm: 1n,
          playerId,
          worldTime: worldTime(),
        });
        size = toBinary(ServerToClientSchema, message).length;
      }

      message.states.push(peer);
      size += embeddedSize(length);
    }

    packets.push(message);

    return packets.map((packet, index) => {
      packet.numMsgs = packets.length;
      packet.msgnum = index + 1;

      return toBinary(ServerToClientSchema, packet);
    });
  }
}
