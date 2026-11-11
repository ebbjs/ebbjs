import { describe, expect, it } from "vitest";

import { decodeFrames, encodeFrame, fits } from "./codec.ts";
import { MAX_FRAME_BYTES, type Frame } from "./frames.ts";
import { call, ready, result } from "./constructors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

function header(length: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
}

describe("encodeFrame and decodeFrames", () => {
  it("prefixes the JSON payload with its UTF-8 byte length, big-endian", () => {
    const frame = result({ ok: true, value: { ok: true } });
    const bytes = encodeFrame(frame);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const json = bytes.subarray(4);

    expect(length).toBe(json.length);
    expect(JSON.parse(decoder.decode(json))).toEqual(frame);
  });

  it("counts bytes, not characters, in the length prefix", () => {
    const frame = result({ ok: true, value: "é—" });
    const bytes = encodeFrame(frame);

    expect(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)).toBe(
      bytes.length - 4,
    );
    expect(decoder.decode(bytes.subarray(4))).toContain("é—");
  });

  it("decodes several buffered frames and returns the trailing partial bytes", () => {
    const first = ready(1, "0.0.0");
    const second = call("1", "get", { id: "e_doc" });
    const third = result({ ok: true, value: null });

    const thirdBytes = encodeFrame(third);
    const thirdPrefix = thirdBytes.subarray(0, thirdBytes.length - 5);
    const thirdTail = thirdBytes.subarray(thirdBytes.length - 5);
    const buffer = concat(encodeFrame(first), encodeFrame(second), thirdPrefix);

    expect(decodeFrames(buffer)).toEqual({ ok: true, frames: [first, second], rest: thirdPrefix });
    expect(decodeFrames(concat(thirdPrefix, thirdTail))).toEqual({
      ok: true,
      frames: [third],
      rest: new Uint8Array(),
    });
  });

  it("decodes a frame split across three arbitrary chunks", () => {
    const frame = call("1", "get", { id: "e_doc" });
    const bytes = encodeFrame(frame);

    const chunks = [bytes.subarray(0, 1), bytes.subarray(1, 8), bytes.subarray(8)];

    const first = decodeFrames(chunks[0]);
    expect(first.ok && first.frames).toEqual([]);
    if (!first.ok) throw new Error("expected a buffered header");

    const second = decodeFrames(concat(first.rest, chunks[1]));
    expect(second.ok && second.frames).toEqual([]);
    if (!second.ok) throw new Error("expected a buffered payload");

    expect(decodeFrames(concat(second.rest, chunks[2]))).toEqual({
      ok: true,
      frames: [frame],
      rest: new Uint8Array(),
    });
  });

  it("buffers an incomplete header", () => {
    const partial = new Uint8Array([0, 0]);

    expect(decodeFrames(partial)).toEqual({ ok: true, frames: [], rest: partial });
  });

  it("accepts an empty buffer", () => {
    expect(decodeFrames(new Uint8Array())).toEqual({
      ok: true,
      frames: [],
      rest: new Uint8Array(),
    });
  });

  it("accepts a Buffer", () => {
    const frame = call("1", "get", { id: "e_doc" });

    expect(decodeFrames(Buffer.from(encodeFrame(frame)))).toEqual({
      ok: true,
      frames: [frame],
      rest: new Uint8Array(),
    });
  });

  it("decodes a payload of exactly the frame bound", () => {
    const empty = JSON.stringify({ type: "result", ok: true, value: "" });
    const frame = { type: "result", ok: true, value: "a".repeat(MAX_FRAME_BYTES - empty.length) };
    const bytes = encodeFrame(frame);

    expect(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)).toBe(
      MAX_FRAME_BYTES,
    );
    expect(decodeFrames(bytes)).toEqual({ ok: true, frames: [frame], rest: new Uint8Array() });
  });

  it("refuses an oversize frame from its length prefix alone", () => {
    const oversize = MAX_FRAME_BYTES + 1;

    expect(decodeFrames(header(oversize))).toEqual({
      ok: false,
      error: { kind: "frame_too_large", length: oversize },
    });
  });

  it("refuses an oversize frame before the frames after it are read", () => {
    const buffer = concat(header(MAX_FRAME_BYTES + 1), encoder.encode("{}"), header(0));

    expect(decodeFrames(buffer)).toEqual({
      ok: false,
      error: { kind: "frame_too_large", length: MAX_FRAME_BYTES + 1 },
    });
  });

  it("refuses an empty frame", () => {
    expect(decodeFrames(header(0))).toEqual({ ok: false, error: { kind: "empty_frame" } });
    expect(decodeFrames(concat(header(0), encoder.encode("{}")))).toEqual({
      ok: false,
      error: { kind: "empty_frame" },
    });
  });

  it("refuses invalid JSON", () => {
    const decoded = decodeFrames(concat(header(3), encoder.encode("no!")));

    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected invalid JSON to be refused");
    expect(decoded.error.kind).toBe("invalid_json");
  });

  it("refuses invalid UTF-8", () => {
    const decoded = decodeFrames(concat(header(2), new Uint8Array([0xff, 0xfe])));

    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected invalid UTF-8 to be refused");
    expect(decoded.error.kind).toBe("invalid_json");
  });

  it("refuses JSON that is not a typed frame", () => {
    const cases: Array<[string, unknown]> = [
      ["[]", []],
      ["{}", {}],
      ['{"type":1}', { type: 1 }],
      ['"invoke"', "invoke"],
      ["null", null],
    ];

    for (const [json, value] of cases) {
      const payload = encoder.encode(json);
      expect(decodeFrames(concat(header(payload.length), payload))).toEqual({
        ok: false,
        error: { kind: "invalid_frame", value },
      });
    }
  });

  it("keeps fields this version does not know", () => {
    const frame: Frame = { type: "invoke", name: "f", future_field: { nested: [1, "two"] } };
    const decoded = decodeFrames(encodeFrame(frame));

    expect(decoded.ok && decoded.frames).toEqual([frame]);
    expect(Object.keys(decoded.ok ? decoded.frames[0] : {})).toEqual([
      "type",
      "name",
      "future_field",
    ]);
  });

  it("keeps a frame whose type this version does not define", () => {
    const frame = { type: "progress", call_id: "1", done: 3 };
    const decoded = decodeFrames(encodeFrame(frame));

    expect(decoded.ok && decoded.frames).toEqual([frame]);
  });

  it("returns the rest as a copy the caller can append to", () => {
    const frame = call("1", "get", { id: "e_doc" });
    const partial = encodeFrame(frame).subarray(0, 6);
    const decoded = decodeFrames(partial);

    if (!decoded.ok) throw new Error("expected a buffered frame");
    expect(decoded.rest).not.toBe(partial);
    expect(decoded.rest).toEqual(partial);
  });
});

describe("fits", () => {
  it("counts the length prefix toward the bound", () => {
    const empty = JSON.stringify(result({ ok: true, value: "" }));
    const value = (payloadBytes: number): string => "a".repeat(payloadBytes - empty.length);

    // The prefix counts toward the bound, matching Elixir's fits?/1: the largest
    // payload that fits is MAX_FRAME_BYTES - 4, not MAX_FRAME_BYTES.
    expect(fits(result({ ok: true, value: value(MAX_FRAME_BYTES - 4) }))).toBe(true);
    expect(fits(result({ ok: true, value: value(MAX_FRAME_BYTES - 3) }))).toBe(false);
  });
});
