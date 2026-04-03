/**
 * Hybrid Logical Clock (HLC)
 *
 * Pure functions for creating, incrementing, receiving, comparing, and
 * serializing Hybrid Logical Clocks. Every character inserted into the
 * document gets a unique ID derived from an HLC timestamp.
 *
 * Algorithm follows Kulkarni et al.'s hybrid logical clock paper.
 * Key invariant: hlc.ts >= Date.now() at the time of creation, and the
 * count disambiguates events that share the same wall-clock millisecond.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Hlc = {
  readonly ts: number; // Wall-clock timestamp (ms since epoch)
  readonly count: number; // Logical counter for same-ts disambiguation
  readonly peerId: string; // Unique identifier for the peer
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TS_PAD = 15; // Covers timestamps through year 2286
const COUNT_PAD = 5; // Allows 99,999 events per millisecond

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Create a fresh HLC initialized to the current wall-clock time with count 0. */
export const createHlc = (peerId: string): Hlc => ({
  ts: Date.now(),
  count: 0,
  peerId,
});

/**
 * Advance the local HLC on a local event.
 *
 * Takes max(Date.now(), local.ts). If ts is unchanged, bumps count;
 * otherwise resets count to 0. Returns a new HLC.
 */
export const increment = (local: Hlc): Hlc => {
  const now = Date.now();
  if (now > local.ts) {
    return { ts: now, count: 0, peerId: local.peerId };
  }
  return { ts: local.ts, count: local.count + 1, peerId: local.peerId };
};

/**
 * Merge a local HLC with a received remote HLC.
 *
 * ts = max(now, local.ts, remote.ts). Count follows HLC merge rules:
 * - If the new ts came from local.ts, keep local.count + 1
 * - If the new ts came from remote.ts, keep remote.count + 1
 * - If both are equal, take max(local.count, remote.count) + 1
 * - If the new ts is now (wall clock advanced), reset count to 0
 *
 * Always keeps the local peer ID.
 */
export const receive = (local: Hlc, remote: Hlc): Hlc => {
  const now = Date.now();
  const maxTs = Math.max(now, local.ts, remote.ts);

  let count: number;
  if (maxTs === local.ts && maxTs === remote.ts) {
    // Both local and remote share the max ts
    count = Math.max(local.count, remote.count) + 1;
  } else if (maxTs === local.ts) {
    // Local ts is the highest
    count = local.count + 1;
  } else if (maxTs === remote.ts) {
    // Remote ts is the highest
    count = remote.count + 1;
  } else {
    // Wall clock advanced past both — reset
    count = 0;
  }

  return { ts: maxTs, count, peerId: local.peerId };
};

/**
 * Total order comparison of two HLCs.
 *
 * Compares first by ts, then by count, then by peerId lexicographically.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export const compare = (a: Hlc, b: Hlc): number => {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.count !== b.count) return a.count - b.count;
  if (a.peerId < b.peerId) return -1;
  if (a.peerId > b.peerId) return 1;
  return 0;
};

/**
 * Serialize an HLC to a deterministic, lexicographically-sortable string.
 *
 * Format: `{ts padded to 15 digits}:{count padded to 5 digits}:{peerId}`
 *
 * String comparison of two serialized HLCs gives the same result as compare().
 */
export const toString = (hlc: Hlc): string => {
  const ts = String(hlc.ts).padStart(TS_PAD, "0");
  const count = String(hlc.count).padStart(COUNT_PAD, "0");
  return `${ts}:${count}:${hlc.peerId}`;
};
