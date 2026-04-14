import { describe, expect, it } from "vitest";
import { encode, decode, encodeSync, decodeSync } from "./index";

describe("encode/decode", () => {
  it("roundtrips simple object", async () => {
    const original = { name: "test", count: 42 };
    const encoded = await encode(original);
    const decoded = await decode(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips object with HLC string (converted to integer)", async () => {
    const original = { hlc: "1234567890123", actor: "a_me" };
    const encoded = await encode(original);
    const decoded = await decode(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips nested object with HLC", async () => {
    const original = {
      action: {
        id: "a_test",
        hlc: "9999999999999",
        data: { name: { value: "hello", update_id: "u_123" } },
      },
    };
    const encoded = await encode(original);
    const decoded = await decode(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips array", async () => {
    const original = [1, 2, 3];
    const encoded = await encode(original);
    const decoded = await decode(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips array with HLC strings", async () => {
    const original = ["1234567890123", "9876543210987"];
    const encoded = await encode(original);
    const decoded = await decode(encoded);
    expect(decoded).toEqual(original);
  });
});

describe("encodeSync/decodeSync", () => {
  it("roundtrips simple object", () => {
    const original = { name: "test", count: 42 };
    const encoded = encodeSync(original);
    const decoded = decodeSync(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips object with HLC string", () => {
    const original = { hlc: "1234567890123", actor: "a_me" };
    const encoded = encodeSync(original);
    const decoded = decodeSync(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips nested object", () => {
    const original = {
      action: { id: "a_test", hlc: "9999999999999" },
    };
    const encoded = encodeSync(original);
    const decoded = decodeSync(encoded);
    expect(decoded).toEqual(original);
  });

  it("roundtrips array with HLC strings", () => {
    const original = ["1234567890123", "9876543210987"];
    const encoded = encodeSync(original);
    const decoded = decodeSync(encoded);
    expect(decoded).toEqual(original);
  });
});

describe("async and sync produce equivalent results", () => {
  it("encodeSync produces decodable output equivalent to async", async () => {
    const original = { hlc: "1234567890123", name: "test" };
    const syncEncoded = encodeSync(original);
    const asyncEncoded = await encode(original);
    const syncDecoded = decodeSync(syncEncoded);
    const asyncDecoded = await decode(asyncEncoded);
    expect(syncDecoded).toEqual(asyncDecoded);
    expect(syncDecoded).toEqual(original);
  });
});
