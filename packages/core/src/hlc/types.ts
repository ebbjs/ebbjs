export interface HLCState {
  l: bigint;
  c: bigint;
}

export interface HLCComponents {
  logicalTime: bigint;
  counter: bigint;
}
