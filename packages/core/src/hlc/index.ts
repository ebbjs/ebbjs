export type { HLCState, HLCComponents } from "./types";

export { COUNTER_BITS, COUNTER_MASK, MAX_FUTURE_DRIFT_MS, MAX_PAST_DRIFT_MS } from "./constants";

export { createClock, localEvent, receiveRemoteHLC } from "./clock";

export { pack, unpack, parse, format } from "./pack";

export { compare, isBefore, isAfter } from "./compare";

export { isValidHLC } from "./validate";
