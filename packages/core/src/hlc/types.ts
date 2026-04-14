export interface HLCState {
  l: bigint;
  c: bigint;
  maxDrift: bigint;
}

export interface HLCComponents {
  logicalTime: bigint;
  counter: bigint;
}
