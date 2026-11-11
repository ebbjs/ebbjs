import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ActionSchema,
  UpdateSchema,
  UpdateInputSchema,
  ComponentNameSchema,
  UpdateMethodSchema,
  FieldValueSchema,
} from "./action";

describe("ComponentNameSchema", () => {
  it("accepts <model>/<field> names", () => {
    for (const name of ["note/title", "group/apps", "a/b_c"]) {
      expect(Value.Check(ComponentNameSchema, name)).toBe(true);
    }
  });

  it("rejects a name without exactly one slash", () => {
    for (const name of ["", "note", "/title", "note/", "note/body/title"]) {
      expect(Value.Check(ComponentNameSchema, name)).toBe(false);
    }
  });
});

describe("UpdateMethodSchema", () => {
  it("accepts the four methods", () => {
    for (const method of ["merge", "replace", "drop", "delete"]) {
      expect(Value.Check(UpdateMethodSchema, method)).toBe(true);
    }
  });

  it("rejects the superseded methods", () => {
    for (const method of ["put", "patch", "post", ""]) {
      expect(Value.Check(UpdateMethodSchema, method)).toBe(false);
    }
  });
});

describe("FieldValueSchema", () => {
  it("accepts a leaf carrying any value", () => {
    for (const value of [
      { value: "test", update_id: "a_test", hlc: "123" },
      { value: 42, update_id: "a_test" },
      { value: null, update_id: "a_test" },
      { value: { nested: true }, update_id: "a_test" },
    ]) {
      expect(Value.Check(FieldValueSchema, value)).toBe(true);
    }
  });

  it("rejects a leaf without update_id", () => {
    expect(Value.Check(FieldValueSchema, { value: "test" })).toBe(false);
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

describe("UpdateSchema", () => {
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
});

describe("UpdateInputSchema", () => {
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

describe("ActionSchema", () => {
  it("accepts a valid action carrying leaf and map component updates", () => {
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
