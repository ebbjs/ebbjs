import { describe, expect, it, beforeEach } from "vitest";
import { createClock, localEvent, receiveRemoteHLC } from "./clock.js";
import { unpack, pack, parse, format } from "./pack.js";
import { COUNTER_MASK } from "./constants.js";

describe("createClock", () => {
  it("returns correct initial state", () => {
    const clock = createClock();
    expect(clock.l).toBe(0n);
    expect(clock.c).toBe(0n);
  });
});

describe("localEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("advances logical time when called after Date.now()", () => {
    const clock = createClock();
    const now = 1000n;
    vi.setSystemTime(Number(now));

    const hlc = localEvent(clock);
    const unpacked = unpack(parse(hlc));

    expect(unpacked.logicalTime).toBe(now);
    expect(unpacked.counter).toBe(0n);
  });

  it("increments counter when called multiple times in same ms", () => {
    const clock = createClock();
    const now = 1000n;
    vi.setSystemTime(Number(now));

    const hlc1 = localEvent(clock);
    const hlc2 = localEvent(clock);
    const hlc3 = localEvent(clock);

    expect(unpack(parse(hlc1)).counter).toBe(0n);
    expect(unpack(parse(hlc2)).counter).toBe(1n);
    expect(unpack(parse(hlc3)).counter).toBe(2n);
  });

  it("wraps counter at 65535", () => {
    const clock = createClock();
    const now = 1000n;
    vi.setSystemTime(Number(now));

    clock.c = COUNTER_MASK;

    const hlc = localEvent(clock);
    const unpacked = unpack(parse(hlc));

    expect(unpacked.counter).toBe(0n);
  });

  it("resets counter when logical time advances", () => {
    const clock = createClock();
    vi.setSystemTime(1000);

    localEvent(clock);
    localEvent(clock);
    expect(unpack(parse(localEvent(clock))).counter).toBe(2n);

    vi.setSystemTime(2000);
    const hlc = localEvent(clock);
    const unpacked = unpack(parse(hlc));

    expect(unpacked.logicalTime).toBe(2000n);
    expect(unpacked.counter).toBe(0n);
  });
});

describe("receiveRemoteHLC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("advances local clock when remote is ahead", () => {
    const clock = createClock();
    clock.l = 1000n;
    clock.c = 5n;

    const remoteHlc = format(pack(2000n, 10n));
    const result = receiveRemoteHLC(clock, remoteHlc);
    const unpacked = unpack(parse(result));

    expect(unpacked.logicalTime).toBe(2000n);
    expect(unpacked.counter).toBe(0n);
  });

  it("takes max counter when remote has same logical time but higher counter", () => {
    const clock = createClock();
    clock.l = 1000n;
    clock.c = 5n;

    const remoteHlc = format(pack(1000n, 10n));
    const result = receiveRemoteHLC(clock, remoteHlc);
    const unpacked = unpack(parse(result));

    expect(unpacked.logicalTime).toBe(1000n);
    expect(unpacked.counter).toBe(10n);
  });

  it("increments counter when local is ahead", () => {
    const clock = createClock();
    clock.l = 2000n;
    clock.c = 5n;

    const remoteHlc = format(pack(1000n, 10n));
    const result = receiveRemoteHLC(clock, remoteHlc);
    const unpacked = unpack(parse(result));

    expect(unpacked.logicalTime).toBe(2000n);
    expect(unpacked.counter).toBe(6n);
  });

  it("throws when drift exceeds server bounds (future)", () => {
    const clock = createClock();
    vi.setSystemTime(200_000);
    clock.l = 0n;

    const remoteHlc = format(pack(50_000n, 0n));
    expect(() => receiveRemoteHLC(clock, remoteHlc)).toThrow("HLC drift exceeds bounds");
  });

  it("throws when drift exceeds server bounds (past)", () => {
    const clock = createClock();
    vi.setSystemTime(100_000_000);

    clock.l = 1n;

    const remoteHlc = format(pack(clock.l, 0n));
    expect(() => receiveRemoteHLC(clock, remoteHlc)).toThrow("HLC drift exceeds bounds");
  });
});
