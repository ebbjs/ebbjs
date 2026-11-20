/**
 * SPIKE S6 (#779): cold start without a `loading` policy.
 *
 * A model, not production code. Three candidate persist policies for the
 * replica record, measured on the same workload:
 *
 * - **A. held-only** (today): the record keeps whatever `loading: "eager"`
 *   declares, plus `notResident` metadata for everything else.
 * - **B. last working set**: the record keeps every component an active
 *   subscription leased at save time.
 * - **C. full resident row**: the record keeps every component of every row
 *   the replica held.
 *
 * Cold start restores the record's values as *leases* (resident, with the
 * inactive TTL), not as permanent holds. A subscription that finds its
 * selection already resident reads nothing; one that does not reads the
 * component from the entity store.
 *
 * Not for merge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLeaseManager } from "./lease";

afterEach(() => vi.useRealTimers());

const COMPONENTS = ["title", "engine", "content", "versions"] as const;
const key = (row: string, component: string): string => `${row}\u0000note/${component}`;

/** `title` is eager today; the other three are lazy bodies. */
const EAGER = new Set(["title"]);

interface Session {
  /** `(row, component)` pairs active subscriptions lease at save time. */
  readonly leased: readonly string[];
}

const workingSet = (session: Session): Set<string> => new Set(session.leased);

/** The record each policy writes, as the set of values it carries. */
const recordFor = (
  policy: "held" | "working-set" | "full-row",
  rows: readonly string[],
  session: Session,
): Set<string> => {
  if (policy === "held") {
    return new Set(rows.flatMap((row) => [...EAGER].map((component) => key(row, component))));
  }
  if (policy === "working-set") {
    const held = new Set(rows.flatMap((row) => [...EAGER].map((component) => key(row, component))));
    for (const leased of workingSet(session)) held.add(leased);
    return held;
  }
  return new Set(rows.flatMap((row) => COMPONENTS.map((component) => key(row, component))));
};

/** Restore the record as leases, then measure a second session's reads. */
const coldStart = (
  persisted: ReadonlySet<string>,
  selection: readonly string[],
  ttlMs: number,
): { readonly storeReads: number; readonly resident: number } => {
  const leases = createLeaseManager({ ttlMs });
  // Hydration seeds residency: a record value is resident but not retained by
  // any subscription, so it is released on the same TTL.
  for (const entry of persisted) leases.acquire(entry)();
  let storeReads = 0;
  for (const entry of selection) {
    if (!leases.isResident(entry)) storeReads += 1;
    leases.acquire(entry);
  }
  return { storeReads, resident: leases.stats().resident };
};

describe("S6: what the record must persist under subscription-owned residency", () => {
  const ROWS = Array.from({ length: 50 }, (_, index) => `n_${index}`);
  const session: Session = {
    // Five notes fully open (title + body), as a documents workspace would be.
    leased: ROWS.slice(0, 5).flatMap((row) => [key(row, "title"), key(row, "content")]),
  };

  it("held-only makes the next session read every body from the store", () => {
    const persisted = recordFor("held", ROWS, session);
    expect(persisted.size).toBe(ROWS.length); // one eager title per row
    const cold = coldStart(persisted, session.leased, 1_000);
    // 5 bodies missing; titles resident.
    expect(cold.storeReads).toBe(5);
    console.log("S6 held-only", { persisted: persisted.size, ...cold });
  });

  it("the last working set makes a same-session remount read nothing", () => {
    const persisted = recordFor("working-set", ROWS, session);
    const cold = coldStart(persisted, session.leased, 1_000);
    expect(cold.storeReads).toBe(0);
    console.log("S6 working-set", { persisted: persisted.size, ...cold });
  });

  it("the full row also reads nothing, but persists everything ever resident", () => {
    const persisted = recordFor("full-row", ROWS, session);
    const cold = coldStart(persisted, session.leased, 1_000);
    expect(cold.storeReads).toBe(0);
    expect(persisted.size).toBe(ROWS.length * COMPONENTS.length);
    console.log("S6 full-row", { persisted: persisted.size, ...cold });
  });

  it("a different next session pays one store read per missing body", () => {
    const persisted = recordFor("working-set", ROWS, session);
    const nextSession = ROWS.slice(5, 10).flatMap((row) => [
      key(row, "title"),
      key(row, "content"),
    ]);
    const cold = coldStart(persisted, nextSession, 1_000);
    // The held titles are already resident; only the five new bodies are read.
    expect(cold.storeReads).toBe(5);
  });

  it("restored values are leases: after the TTL they are gone", () => {
    vi.useFakeTimers();
    const { storeReads, resident } = coldStart(recordFor("working-set", ROWS, session), [], 1_000);
    expect(storeReads).toBe(0);
    expect(resident).toBeGreaterThan(0);
    vi.advanceTimersByTime(1_000);
    // Nothing holds them, so nothing is resident: a later subscription reads
    // from the store rather than pinning the last session's working set forever.
    const later = coldStart(new Set(), session.leased, 1_000);
    expect(later.storeReads).toBe(session.leased.length);
  });
});
