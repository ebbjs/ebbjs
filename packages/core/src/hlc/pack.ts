import { HLCComponents } from "./types";

export const COUNTER_BITS = 16n;
export const COUNTER_MASK = 0xffffn;

export function pack(logicalTime: bigint, counter: bigint): bigint {
  return (logicalTime << COUNTER_BITS) | (counter & COUNTER_MASK);
}

export function unpack(hlc: bigint): HLCComponents {
  return {
    logicalTime: hlc >> COUNTER_BITS,
    counter: hlc & COUNTER_MASK,
  };
}

export function parse(hlc: string): bigint {
  return BigInt(hlc);
}

export function format(hlc: bigint): string {
  return hlc.toString();
}
