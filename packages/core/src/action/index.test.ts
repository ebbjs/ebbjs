import { describe, expect, it, beforeEach, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createClock } from "../hlc/clock";
import { ActionSchema, type UpdateInput } from "../types/action";
import { createAction } from "./index";

describe("createAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("produces an Action that validates against the wire schema", () => {
    const clock = createClock();
    vi.setSystemTime(1000);
    const { action } = createAction({
      actorId: "a_me",
      updates: [
        {
          subject_id: "a_target",
          component: "group/name",
          method: "replace",
          data: { value: "Group", update_id: "u_value" },
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

  it("leaves gsn at 0, for the server to assign", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(action.gsn).toBe(0);
  });

  it("stamps the action with the HLC it returns", () => {
    const clock = createClock();
    vi.setSystemTime(12345);
    const { action, hlc } = createAction({
      actorId: "a_me",
      updates: [],
      clock,
    });
    expect(hlc).toBe((12345n << 16n).toString());
    expect(action.hlc).toBe(hlc);
  });

  it("generates unique IDs for updates when not provided", () => {
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [
        { subject_id: "a_target", method: "delete", data: null },
        { subject_id: "a_target", component: "group/name", method: "drop", data: null },
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
          method: "delete",
          data: null,
        },
      ],
      clock,
    });
    expect(action.updates[0].id).toBe("u_mycustomid");
  });

  it("strips a component from a delete, which names only the row", () => {
    // The union forbids a `delete` carrying a component, but a JS caller or a
    // decoded payload can still send one, so `createAction` normalizes it
    // rather than stamping the extra key onto the wire.
    const untypedDelete = {
      subject_id: "a_target",
      component: "group/name",
      method: "delete",
      data: null,
    } as unknown as UpdateInput;
    const clock = createClock();
    const { action } = createAction({
      actorId: "a_me",
      updates: [untypedDelete],
      clock,
    });
    expect(action.updates[0]).not.toHaveProperty("component");
    expect(Value.Check(ActionSchema, action)).toBe(true);
  });
});
