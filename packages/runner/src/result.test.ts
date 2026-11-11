import { describe, expect, it } from "vitest";

import { encodeFrame, MAX_FRAME_BYTES } from "@ebbjs/functions-protocol";

import { boundedResultFrame } from "./result.ts";

const bytes = (frame: ReturnType<typeof boundedResultFrame>): number => encodeFrame(frame).length;

const hugeValue = (): string => "x".repeat(MAX_FRAME_BYTES);

describe("boundedResultFrame", () => {
  it("sends a result that fits unchanged", () => {
    const frame = boundedResultFrame({ ok: true, value: { id: "e_1" } });

    expect(frame).toEqual({ type: "result", ok: true, value: { id: "e_1" } });
  });

  it("turns an oversize success into output_too_large", () => {
    const frame = boundedResultFrame({ ok: true, value: hugeValue() });

    expect(frame.ok).toBe(false);
    expect(frame).toMatchObject({ type: "result", kind: "output_too_large" });
    expect(bytes(frame)).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("honours a smaller max_output_bytes", () => {
    const frame = boundedResultFrame({ ok: true, value: "x".repeat(200) }, 200);

    expect(frame).toMatchObject({ kind: "output_too_large" });
    expect(bytes(frame)).toBeLessThanOrEqual(200);
  });

  it("still reports a pathological cap instead of sending nothing", () => {
    const frame = boundedResultFrame({ ok: true, value: "x".repeat(200) }, 16);

    expect(frame).toMatchObject({ kind: "output_too_large" });
    expect(bytes(frame)).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("never exceeds the frame bound even when the host asks for more", () => {
    const frame = boundedResultFrame({ ok: true, value: hugeValue() }, MAX_FRAME_BYTES * 4);

    expect(frame).toMatchObject({ kind: "output_too_large" });
  });

  it("keeps a failure's kind and clips a message that cannot be framed", () => {
    const frame = boundedResultFrame({
      ok: false,
      kind: "handler_error",
      message: "x".repeat(MAX_FRAME_BYTES),
    });

    expect(frame.ok).toBe(false);
    expect(frame).toMatchObject({ kind: "handler_error" });
    expect(bytes(frame)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("passes a normal failure through", () => {
    const frame = boundedResultFrame({ ok: false, kind: "host_call_limit", message: "too many" });

    expect(frame).toEqual({
      type: "result",
      ok: false,
      kind: "host_call_limit",
      message: "too many",
    });
  });
});
