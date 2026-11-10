import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema } from "./hlc";
import {
  ActionSchema,
  UpdateSchema,
  UpdateInputSchema,
  ComponentNameSchema,
  UpdateMethodSchema,
  FieldValueSchema,
} from "./action";

describe("NanoId", () => {
  it("accepts valid NanoId patterns", () => {
    expect(Value.Check(NanoIdSchema, "a_test")).toBe(true);
    expect(Value.Check(NanoIdSchema, "abc_def123")).toBe(true);
    expect(Value.Check(NanoIdSchema, "a_ABCDEF123456")).toBe(true);
    expect(Value.Check(NanoIdSchema, "group_abc")).toBe(true);
  });

  it("rejects invalid NanoId patterns", () => {
    expect(Value.Check(NanoIdSchema, "")).toBe(false);
    expect(Value.Check(NanoIdSchema, "abc")).toBe(false);
    expect(Value.Check(NanoIdSchema, "_test")).toBe(false);
    expect(Value.Check(NanoIdSchema, "test_")).toBe(false);
    expect(Value.Check(NanoIdSchema, "a_")).toBe(false);
  });
});

describe("HLCTimestamp", () => {
  it("accepts non-empty decimal string", () => {
    expect(Value.Check(HLCTimestampSchema, "123456789")).toBe(true);
    expect(Value.Check(HLCTimestampSchema, "0")).toBe(true);
    expect(Value.Check(HLCTimestampSchema, "9999999999999")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(Value.Check(HLCTimestampSchema, "")).toBe(false);
  });
});

describe("ComponentName", () => {
  it("accepts <model>/<field> names", () => {
    expect(Value.Check(ComponentNameSchema, "note/title")).toBe(true);
    expect(Value.Check(ComponentNameSchema, "group/apps")).toBe(true);
    expect(Value.Check(ComponentNameSchema, "a/b_c")).toBe(true);
  });

  it("rejects a name without exactly one slash", () => {
    expect(Value.Check(ComponentNameSchema, "")).toBe(false);
    expect(Value.Check(ComponentNameSchema, "note")).toBe(false);
    expect(Value.Check(ComponentNameSchema, "/title")).toBe(false);
    expect(Value.Check(ComponentNameSchema, "note/")).toBe(false);
    expect(Value.Check(ComponentNameSchema, "note/body/title")).toBe(false);
  });
});

describe("UpdateMethod", () => {
  it("accepts valid update methods", () => {
    expect(Value.Check(UpdateMethodSchema, "merge")).toBe(true);
    expect(Value.Check(UpdateMethodSchema, "replace")).toBe(true);
    expect(Value.Check(UpdateMethodSchema, "drop")).toBe(true);
    expect(Value.Check(UpdateMethodSchema, "delete")).toBe(true);
  });

  it("rejects the superseded methods", () => {
    expect(Value.Check(UpdateMethodSchema, "put")).toBe(false);
    expect(Value.Check(UpdateMethodSchema, "patch")).toBe(false);
    expect(Value.Check(UpdateMethodSchema, "post")).toBe(false);
    expect(Value.Check(UpdateMethodSchema, "")).toBe(false);
  });
});

describe("FieldValue", () => {
  it("accepts valid field values", () => {
    expect(Value.Check(FieldValueSchema, { value: "test", update_id: "a_test", hlc: "123" })).toBe(
      true,
    );
    expect(Value.Check(FieldValueSchema, { value: 42, update_id: "a_test" })).toBe(true);
    expect(Value.Check(FieldValueSchema, { value: null, update_id: "a_test" })).toBe(true);
    expect(Value.Check(FieldValueSchema, { value: { nested: true }, update_id: "a_test" })).toBe(
      true,
    );
  });

  it("rejects field values without update_id", () => {
    expect(Value.Check(FieldValueSchema, { value: "test" })).toBe(false);
  });

  it("rejects invalid update_id format", () => {
    expect(Value.Check(FieldValueSchema, { value: "test", update_id: "invalid" })).toBe(false);
  });

  it("accepts a map variant with leaf entries", () => {
    expect(
      Value.Check(FieldValueSchema, {
        map: {
          a: { value: "x", update_id: "a_test", hlc: "123" },
          b: { value: 2, update_id: "a_test2" },
        },
      }),
    ).toBe(true);
  });

  it("accepts nested map variants", () => {
    expect(
      Value.Check(FieldValueSchema, {
        map: { outer: { map: { inner: { value: 1, update_id: "a_test" } } } },
      }),
    ).toBe(true);
  });

  it("rejects a map entry without update_id", () => {
    expect(Value.Check(FieldValueSchema, { map: { a: { value: "x" } } })).toBe(false);
  });

  it("accepts a tombstoned map entry (value: null)", () => {
    expect(
      Value.Check(FieldValueSchema, { map: { a: { value: null, update_id: "a_test" } } }),
    ).toBe(true);
  });
});

const leaf = { value: "test", update_id: "u_upd1" };

describe("Update", () => {
  it("accepts merge and replace carrying a component value", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/name",
        method: "merge",
        data: leaf,
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/apps",
        method: "replace",
        data: { map: { app: leaf } },
      }),
    ).toBe(true);
  });

  it("accepts drop with null data", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/name",
        method: "drop",
        data: null,
      }),
    ).toBe(true);
  });

  it("accepts delete with no component", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        method: "delete",
        data: null,
      }),
    ).toBe(true);
  });

  it("rejects a delete that names a component", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/name",
        method: "delete",
        data: null,
      }),
    ).toBe(false);
  });

  it("rejects a component method with no component", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        method: "merge",
        data: leaf,
      }),
    ).toBe(false);
  });

  it("rejects a component whose name is not <model>/<field>", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group",
        method: "merge",
        data: leaf,
      }),
    ).toBe(false);
  });

  it("rejects the superseded row-field envelope", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/name",
        method: "merge",
        data: { fields: { name: leaf } },
      }),
    ).toBe(false);
  });

  it("rejects update missing id", () => {
    expect(Value.Check(UpdateSchema, { subject_id: "a_actor", method: "delete", data: null })).toBe(
      false,
    );
  });

  it("rejects update with invalid method", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "group/name",
        method: "post",
        data: null,
      }),
    ).toBe(false);
  });
});

describe("UpdateInput", () => {
  it("accepts an unstamped update", () => {
    expect(
      Value.Check(UpdateInputSchema, {
        subject_id: "a_actor",
        component: "group/name",
        method: "replace",
        data: leaf,
      }),
    ).toBe(true);
  });

  it("accepts a stamped delete", () => {
    expect(
      Value.Check(UpdateInputSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        method: "delete",
        data: null,
      }),
    ).toBe(true);
  });
});

describe("Action", () => {
  it("accepts valid action", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: 0,
      updates: [
        {
          id: "u_updid",
          subject_id: "a_actor",
          component: "group/name",
          method: "replace",
          data: leaf,
        },
      ],
    };
    expect(Value.Check(ActionSchema, action)).toBe(true);
  });

  it("accepts action with multiple component updates", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: 5,
      updates: [
        {
          id: "u_upd1",
          subject_id: "a_actor",
          component: "group/name",
          method: "replace",
          data: leaf,
        },
        {
          id: "u_upd2",
          subject_id: "a_actor",
          component: "group/apps",
          method: "merge",
          data: { map: { app: leaf } },
        },
      ],
    };
    expect(Value.Check(ActionSchema, action)).toBe(true);
  });

  it("rejects action missing actor_id", () => {
    const action = {
      id: "a_testid",
      hlc: "123456789",
      gsn: 0,
      updates: [],
    };
    expect(Value.Check(ActionSchema, action)).toBe(false);
  });

  it("rejects action with invalid gsn", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: -1,
      updates: [],
    };
    expect(Value.Check(ActionSchema, action)).toBe(false);
  });

  it("rejects action with non-array updates", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: 0,
      updates: "not an array",
    };
    expect(Value.Check(ActionSchema, action)).toBe(false);
  });
});
