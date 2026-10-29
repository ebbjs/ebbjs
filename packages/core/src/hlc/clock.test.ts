import { describe, expect, it, beforeEach } from "vitest";
import { createClock, localEvent, receiveRemoteHLC } from "./clock";
import { unpack, pack, parse, format } from "./pack";
import { COUNTER_MASK } from "./constants";

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
  const NOW = 1_790_000_000_000n;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("advances local clock when remote is ahead", () => {
    vi.setSystemTime(1000);
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
    vi.setSystemTime(1000);
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
    vi.setSystemTime(1000);
    const clock = createClock();
    clock.l = 2000n;
    clock.c = 5n;

    const remoteHlc = format(pack(1000n, 10n));
    const result = receiveRemoteHLC(clock, remoteHlc);
    const unpacked = unpack(parse(result));

    expect(unpacked.logicalTime).toBe(2000n);
    expect(unpacked.counter).toBe(6n);
  });

  it("refuses a remote HLC more than 120s ahead and leaves the clock untouched", () => {
    vi.setSystemTime(Number(NOW));
    const clock = { l: 1000n, c: 7n };

    const remoteHlc = format(pack(NOW + 120_001n, 3n));

    expect(() => receiveRemoteHLC(clock, remoteHlc)).toThrow("HLC drift exceeds bounds");
    // A rejected merge is a no-op: neither field moved.
    expect(clock).toEqual({ l: 1000n, c: 7n });
  });

  it("accepts a remote HLC exactly at the +120s boundary", () => {
    vi.setSystemTime(Number(NOW));
    const clock = createClock();

    const remoteHlc = format(pack(NOW + 120_000n, 3n));
    const result = receiveRemoteHLC(clock, remoteHlc);

    expect(unpack(parse(result))).toEqual({ logicalTime: NOW + 120_000n, counter: 0n });
  });

  it("accepts a remote HLC arbitrarily in the past (catch-up replay)", () => {
    vi.setSystemTime(Number(NOW));
    const clock = createClock();
    const oldLogicalTime = NOW - 30n * 86_400_000n;

    const result = receiveRemoteHLC(clock, format(pack(oldLogicalTime, 2n)));

    expect(unpack(parse(result))).toEqual({ logicalTime: oldLogicalTime, counter: 0n });
    expect(clock.l).toBe(oldLogicalTime);
  });

  it("keeps the local clock when the remote HLC is older than state.l", () => {
    vi.setSystemTime(Number(NOW));
    const localLogicalTime = NOW + 60_000n;
    const clock = { l: localLogicalTime, c: 4n };

    const result = receiveRemoteHLC(clock, format(pack(NOW - 86_400_000n, 10n)));

    expect(unpack(parse(result))).toEqual({ logicalTime: localLogicalTime, counter: 5n });
    expect(clock).toEqual({ l: localLogicalTime, c: 5n });
  });
});
