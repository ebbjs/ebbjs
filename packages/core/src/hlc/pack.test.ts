import { describe, expect, it } from "vitest";
import { pack, unpack, parse, format, COUNTER_BITS, COUNTER_MASK } from "./pack";

describe("pack", () => {
  it("packs logical time and counter into 64-bit integer", () => {
    const logicalTime = 1000n;
    const counter = 5n;
    const result = pack(logicalTime, counter);
    expect(result).toBe((logicalTime << COUNTER_BITS) | counter);
  });

  it("masks counter to 16 bits", () => {
    const logicalTime = 1000n;
    const counter = 0x1ffffn;
    const result = pack(logicalTime, counter);
    expect(result).toBe((logicalTime << COUNTER_BITS) | (counter & COUNTER_MASK));
  });
});

describe("unpack", () => {
  it("unpacks logical time from upper bits", () => {
    const logicalTime = 2000n;
    const counter = 10n;
    const packed = pack(logicalTime, counter);
    const result = unpack(packed);
    expect(result.logicalTime).toBe(logicalTime);
  });

  it("unpacks counter from lower 16 bits", () => {
    const logicalTime = 2000n;
    const counter = 10n;
    const packed = pack(logicalTime, counter);
    const result = unpack(packed);
    expect(result.counter).toBe(counter);
  });

  it("roundtrips through pack/unpack", () => {
    const logicalTime = 5000n;
    const counter = 100n;
    const packed = pack(logicalTime, counter);
    const unpacked = unpack(packed);
    expect(unpacked.logicalTime).toBe(logicalTime);
    expect(unpacked.counter).toBe(counter);
  });
});

describe("parse", () => {
  it("parses decimal string to bigint", () => {
    expect(parse("123456789")).toBe(123456789n);
    expect(parse("0")).toBe(0n);
  });
});

describe("format", () => {
  it("formats bigint to decimal string", () => {
    expect(format(123456789n)).toBe("123456789");
    expect(format(0n)).toBe("0");
  });
});

describe("parse/format roundtrip", () => {
  it("parse(format(x)) equals x", () => {
    const hlc = 987654321n;
    expect(parse(format(hlc))).toBe(hlc);
  });
});
