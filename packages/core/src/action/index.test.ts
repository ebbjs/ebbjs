import { describe, expect, it, beforeEach } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createClock } from "../hlc/clock";
import { ActionSchema } from "../types/action";
import { createAction } from "./index";

describe("createAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("produces a valid Action", () => {
    const clock = createClock();
    vi.setSystemTime(1000);
    const { action } = createAction({
      actorId: "a_me",
      updates: [
        {
          subject_id: "a_target",
          subject_type: "group",
          method: "put",
          data: null,
        },
      ],
      clock,
    });
    expect(Value.Check(ActionSchema, action)).toBe(true);
  });

  it("assigns the given actor_id", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_actor123",
      updates: [],
      clock,
    });
    expect(action.actor_id).toBe("a_actor123");
  });

  it("generates an HLC timestamp", () => {
    const clock = createClock();
    vi.setSystemTime(5000);
    const { hlc } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(hlc).toBeDefined();
    expect(typeof hlc).toBe("string");
    expect(hlc.length).toBeGreaterThan(0);
  });

  it("sets gsn to 0", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(action.gsn).toBe(0);
  });

  it("generates unique IDs for updates when not provided", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [
        { subject_id: "a_target", subject_type: "group", method: "put", data: null },
        { subject_id: "a_target", subject_type: "group", method: "patch", data: null },
      ],
      clock,
    });
    expect(action.updates[0].id).toMatch(/^u_[a-z0-9]{16}$/);
    expect(action.updates[1].id).toMatch(/^u_[a-z0-9]{16}$/);
    expect(action.updates[0].id).not.toBe(action.updates[1].id);
  });

  it("uses provided update IDs when given", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [
        {
          id: "u_mycustomid",
          subject_id: "a_target",
          subject_type: "group",
          method: "put",
          data: null,
        },
      ],
      clock,
    });
    expect(action.updates[0].id).toBe("u_mycustomid");
  });

  it("generates an action ID", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(action.id).toMatch(/^a_[a-z0-9]{16}$/);
  });

  it("returns the generated HLC", () => {
    const clock = createClock();
    vi.setSystemTime(12345);
    const { hlc } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(hlc).toBe((12345n << 16n).toString());
  });
});
