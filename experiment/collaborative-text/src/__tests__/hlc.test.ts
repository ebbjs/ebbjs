import { describe, expect, it } from "vitest";
import { compare, createHlc, increment, receive, toString, type Hlc } from "../hlc.ts";

describe("createHlc", () => {
  it("creates an HLC with count 0 and the given peerId", () => {
    const hlc = createHlc("peer-A");
    expect(hlc.count).toBe(0);
    expect(hlc.peerId).toBe("peer-A");
    expect(hlc.ts).toBeGreaterThan(0);
  });

  it("uses a wall-clock timestamp close to Date.now()", () => {
    const before = Date.now();
    const hlc = createHlc("peer-A");
    const after = Date.now();
    expect(hlc.ts).toBeGreaterThanOrEqual(before);
    expect(hlc.ts).toBeLessThanOrEqual(after);
  });
});

describe("increment", () => {
  it("advances ts to Date.now() when wall clock has moved forward", () => {
    const old: Hlc = { ts: 1000, count: 5, peerId: "peer-A" };
    const next = increment(old);
    // Date.now() is well past ts=1000, so ts should advance and count resets
    expect(next.ts).toBeGreaterThan(1000);
    expect(next.count).toBe(0);
    expect(next.peerId).toBe("peer-A");
  });

  it("bumps count when wall clock has not advanced past local ts", () => {
    // Set local.ts to the far future so Date.now() cannot exceed it
    const futureTs = Date.now() + 1_000_000;
    const old: Hlc = { ts: futureTs, count: 3, peerId: "peer-A" };
    const next = increment(old);
    expect(next.ts).toBe(futureTs);
    expect(next.count).toBe(4);
    expect(next.peerId).toBe("peer-A");
  });

  it("produces monotonically increasing HLCs", () => {
    let hlc = createHlc("peer-A");
    for (let i = 0; i < 100; i++) {
      const next = increment(hlc);
      expect(compare(next, hlc)).toBeGreaterThan(0);
      hlc = next;
    }
  });
});

describe("receive", () => {
  it("merges with a remote HLC that has a higher ts", () => {
    const local: Hlc = { ts: 1000, count: 5, peerId: "peer-A" };
    const remote: Hlc = { ts: Date.now() + 1_000_000, count: 3, peerId: "peer-B" };
    const merged = receive(local, remote);
    // Remote ts is the highest
    expect(merged.ts).toBe(remote.ts);
    expect(merged.count).toBe(remote.count + 1);
    expect(merged.peerId).toBe("peer-A"); // always keeps local peer ID
  });

  it("merges when local and remote share the same ts", () => {
    const sharedTs = Date.now() + 1_000_000; // future so wall clock can't exceed
    const local: Hlc = { ts: sharedTs, count: 3, peerId: "peer-A" };
    const remote: Hlc = { ts: sharedTs, count: 7, peerId: "peer-B" };
    const merged = receive(local, remote);
    expect(merged.ts).toBe(sharedTs);
    expect(merged.count).toBe(8); // max(3, 7) + 1
    expect(merged.peerId).toBe("peer-A");
  });

  it("merges when local ts is higher than remote", () => {
    const local: Hlc = { ts: Date.now() + 1_000_000, count: 2, peerId: "peer-A" };
    const remote: Hlc = { ts: 1000, count: 10, peerId: "peer-B" };
    const merged = receive(local, remote);
    expect(merged.ts).toBe(local.ts);
    expect(merged.count).toBe(local.count + 1);
    expect(merged.peerId).toBe("peer-A");
  });

  it("resets count when wall clock is the highest", () => {
    const local: Hlc = { ts: 1000, count: 5, peerId: "peer-A" };
    const remote: Hlc = { ts: 2000, count: 3, peerId: "peer-B" };
    // Date.now() is well past both, so wall clock wins
    const merged = receive(local, remote);
    expect(merged.ts).toBeGreaterThanOrEqual(Date.now() - 1);
    expect(merged.count).toBe(0);
    expect(merged.peerId).toBe("peer-A");
  });

  it("produces an HLC greater than both inputs", () => {
    const local: Hlc = { ts: Date.now() + 500_000, count: 10, peerId: "peer-A" };
    const remote: Hlc = { ts: Date.now() + 500_000, count: 20, peerId: "peer-B" };
    const merged = receive(local, remote);
    expect(compare(merged, local)).toBeGreaterThan(0);
    expect(compare(merged, remote)).toBeGreaterThan(0);
  });
});

describe("compare", () => {
  it("orders by ts first", () => {
    const a: Hlc = { ts: 100, count: 99, peerId: "z" };
    const b: Hlc = { ts: 200, count: 0, peerId: "a" };
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, a)).toBeGreaterThan(0);
  });

  it("orders by count when ts is equal", () => {
    const a: Hlc = { ts: 100, count: 1, peerId: "z" };
    const b: Hlc = { ts: 100, count: 2, peerId: "a" };
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, a)).toBeGreaterThan(0);
  });

  it("orders by peerId when ts and count are equal", () => {
    const a: Hlc = { ts: 100, count: 1, peerId: "peer-A" };
    const b: Hlc = { ts: 100, count: 1, peerId: "peer-B" };
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical HLCs", () => {
    const a: Hlc = { ts: 100, count: 1, peerId: "peer-A" };
    const b: Hlc = { ts: 100, count: 1, peerId: "peer-A" };
    expect(compare(a, b)).toBe(0);
  });
});

describe("toString", () => {
  it("produces a zero-padded sortable string", () => {
    const hlc: Hlc = { ts: 1234567890123, count: 42, peerId: "peer-A" };
    const s = toString(hlc);
    expect(s).toBe("001234567890123:00042:peer-A");
  });

  it("pads ts to 15 digits", () => {
    const hlc: Hlc = { ts: 1, count: 0, peerId: "x" };
    const s = toString(hlc);
    expect(s).toBe("000000000000001:00000:x");
  });

  it("preserves lexicographic ordering consistent with compare()", () => {
    const hlcs: Hlc[] = [
      { ts: 100, count: 0, peerId: "peer-B" },
      { ts: 100, count: 0, peerId: "peer-A" },
      { ts: 100, count: 1, peerId: "peer-A" },
      { ts: 200, count: 0, peerId: "peer-A" },
      { ts: 50, count: 99, peerId: "peer-Z" },
    ];

    // Sort by compare
    const byCompare = [...hlcs].sort(compare);
    // Sort by toString (lexicographic)
    const byString = [...hlcs].sort((a, b) => {
      const sa = toString(a);
      const sb = toString(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    // Both orderings should produce the same sequence
    for (let i = 0; i < hlcs.length; i++) {
      expect(byCompare[i]).toBe(byString[i]);
    }
  });
});
