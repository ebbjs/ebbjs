import { describe, it, expect } from "vitest";
import { makeHlc } from "./make";
import { parse, unpack } from "./pack";

describe("makeHlc", () => {
  it("packs ms << 16 at counter 0", () => {
    expect(makeHlc(1711036800000)).toBe("112134507724800000");
  });

  it("packs ms << 16 | 1 at counter 1", () => {
    expect(makeHlc(1711036800000, 1)).toBe("112134507724800001");
  });

  it("accepts bigint inputs", () => {
    expect(makeHlc(1711036800000n, 2n)).toBe("112134507724800002");
  });

  it("round-trips through parse/unpack", () => {
    const hlc = makeHlc(1711036800000, 7);
    const { logicalTime, counter } = unpack(parse(hlc));
    expect(logicalTime).toBe(1711036800000n);
    expect(counter).toBe(7n);
  });
});
