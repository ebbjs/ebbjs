import { HLCState } from "./types.js";
import {
  COUNTER_MASK,
  DEFAULT_MAX_DRIFT_MS,
  MAX_FUTURE_DRIFT_MS,
  MAX_PAST_DRIFT_MS,
} from "./constants.js";
import { pack, unpack, parse, format } from "./pack.js";

export function createClock(maxDrift?: bigint): HLCState {
  return {
    l: 0n,
    c: 0n,
    maxDrift: maxDrift ?? DEFAULT_MAX_DRIFT_MS,
  };
}

export function localEvent(state: HLCState): string {
  const now = BigInt(Date.now());

  if (now > state.l) {
    state.l = now;
    state.c = 0n;
  } else {
    state.c = (state.c + 1n) & COUNTER_MASK;
  }

  return format(pack(state.l, state.c));
}

export function receiveRemoteHLC(state: HLCState, remoteHlc: string): string {
  const remote = unpack(parse(remoteHlc));
  const now = BigInt(Date.now());

  if (remote.logicalTime > state.l) {
    state.l = remote.logicalTime;
    state.c = 0n;
  } else if (remote.logicalTime === state.l && remote.counter > state.c) {
    state.c = remote.counter;
  } else {
    state.c = (state.c + 1n) & COUNTER_MASK;
  }

  const drift = now - state.l;
  if (drift > MAX_FUTURE_DRIFT_MS || -drift > MAX_PAST_DRIFT_MS) {
    throw new Error(`HLC drift exceeds bounds: ${drift}`);
  }

  return format(pack(state.l, state.c));
}
