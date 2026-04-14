export type { HLCState, HLCComponents } from "./types.js";

export { COUNTER_BITS, COUNTER_MASK, MAX_FUTURE_DRIFT_MS, MAX_PAST_DRIFT_MS } from "./constants.js";

export { createClock, localEvent, receiveRemoteHLC } from "./clock.js";

export { pack, unpack, parse, format } from "./pack.js";

export { compare, isBefore, isAfter } from "./compare.js";

export { isValidHLC } from "./validate.js";
