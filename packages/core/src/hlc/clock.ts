import { HLCState } from "./types";
import { COUNTER_MASK, MAX_FUTURE_DRIFT_MS } from "./constants";
import { pack, unpack, parse, format } from "./pack";

export function createClock(): HLCState {
  return {
    l: 0n,
    c: 0n,
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

  // Mirrors ebb_server's ActionValidator: refuse a remote HLC more than 120s
  // ahead of the wall clock. Any past HLC is accepted — an old HLC only loses
  // the merge, and rejecting it would break replay of old Actions. Only the
  // top-level Action HLC is merged: client-built leaves come from this clock
  // and are at or below the Action HLC, `duplicate()` copies a peer's leaves
  // verbatim, and the server bounds leaves since #628.
  const ahead = remote.logicalTime - now;
  if (ahead > MAX_FUTURE_DRIFT_MS) {
    throw new Error(`HLC drift exceeds bounds: ${ahead}ms ahead of the wall clock`);
  }

  if (remote.logicalTime > state.l) {
    state.l = remote.logicalTime;
    state.c = 0n;
  } else if (remote.logicalTime === state.l && remote.counter > state.c) {
    state.c = remote.counter;
  } else {
    state.c = (state.c + 1n) & COUNTER_MASK;
  }

  return format(pack(state.l, state.c));
}
