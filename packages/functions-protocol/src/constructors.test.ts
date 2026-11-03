import { describe, expect, it } from "vitest";

import { call, invoke, ready, reply, result } from "./constructors.ts";
import { compatibleVersion, PROTOCOL_VERSION } from "./frames.ts";

describe("constructors", () => {
  it("builds the host-to-runner frames", () => {
    expect(invoke({ name: "proofreadDocument", subject_actor_id: "a_test" })).toEqual({
      type: "invoke",
      name: "proofreadDocument",
      subject_actor_id: "a_test",
    });

    expect(reply("1", { ok: true, value: { id: "e_doc" } })).toEqual({
      type: "reply",
      call_id: "1",
      ok: true,
      value: { id: "e_doc" },
    });

    expect(reply("2", { ok: false, error: { error: "rejected" } })).toEqual({
      type: "reply",
      call_id: "2",
      ok: false,
      error: { error: "rejected" },
    });
  });

  it("builds the runner-to-host frames", () => {
    expect(ready(4242, "0.0.0")).toEqual({
      type: "ready",
      pid: 4242,
      runner_version: "0.0.0",
      protocol_version: 1,
    });

    expect(call("1", "get", { id: "e_doc" })).toEqual({
      type: "call",
      call_id: "1",
      op: "get",
      payload: { id: "e_doc" },
    });

    expect(result({ ok: true, value: { ok: true } })).toEqual({
      type: "result",
      ok: true,
      value: { ok: true },
    });

    expect(result({ ok: false, kind: "handler_error", message: "boom" })).toEqual({
      type: "result",
      ok: false,
      kind: "handler_error",
      message: "boom",
    });
  });

  it("omits fields the caller leaves out", () => {
    expect(invoke()).toEqual({ type: "invoke" });
    expect(invoke({ name: "f", input: undefined })).toEqual({ type: "invoke", name: "f" });
    expect(Object.keys(invoke({ name: "f", env: undefined }))).toEqual(["name", "type"]);
  });

  it("does not let a caller replace the frame type", () => {
    expect(invoke({ type: "result", name: "f" })).toEqual({ type: "invoke", name: "f" });
  });

  it("passes unknown invoke fields through", () => {
    expect(invoke({ name: "f", future_field: [1, 2] })).toEqual({
      type: "invoke",
      name: "f",
      future_field: [1, 2],
    });
  });

  it("reports the protocol version and refuses any other", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(compatibleVersion(1)).toBe(true);
    expect(compatibleVersion(0)).toBe(false);
    expect(compatibleVersion(2)).toBe(false);
    expect(compatibleVersion("1")).toBe(false);
    expect(compatibleVersion(null)).toBe(false);
    expect(compatibleVersion(undefined)).toBe(false);
  });

  it("uses the protocol version as the default `ready` version", () => {
    expect(ready(1, "0.0.0").protocol_version).toBe(PROTOCOL_VERSION);
    expect(ready(1, "0.0.0", 7).protocol_version).toBe(7);
  });
});
