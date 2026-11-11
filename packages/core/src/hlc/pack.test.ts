import { describe, expect, it } from "vitest";
import { pack, unpack, COUNTER_MASK } from "./pack";
import { makeHlc } from "./make";

describe("pack/unpack", () => {
  it("round-trips logical time and counter", () => {
    const unpacked = unpack(pack(5000n, 100n));
    expect(unpacked).toEqual({ logicalTime: 5000n, counter: 100n });
  });

  it("masks the counter so an overflow cannot carry into logical time", () => {
    expect(pack(1000n, COUNTER_MASK + 1n)).toBe(pack(1000n, 0n));
  });
});

describe("makeHlc", () => {
  it("builds the HLC a clock pinned at the same millisecond would emit", () => {
    const { logicalTime, counter } = unpack(BigInt(makeHlc(1711036800000, 7n)));
    expect(logicalTime).toBe(1711036800000n);
    expect(counter).toBe(7n);
  });
});
