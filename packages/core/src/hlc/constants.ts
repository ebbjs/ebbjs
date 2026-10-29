export const COUNTER_BITS = 16n;
export const COUNTER_MASK = 0xffffn;

// The server's ActionValidator holds Actions to the same bound, so a value
// adopted here never mints an Action the server would refuse.
export const MAX_FUTURE_DRIFT_MS = 120_000n;
