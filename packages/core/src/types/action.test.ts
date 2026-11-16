import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ActionSchema,
  UpdateSchema,
  UpdateInputSchema,
  ComponentNameSchema,
  ModelNameSchema,
  UpdateMethodSchema,
  FieldValueSchema,
  isComponentUpdate,
  isRowCreate,
  updateComponentValue,
  type Update,
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

describe("ModelNameSchema", () => {
  it("accepts a bare model name", () => {
    for (const name of ["todo", "ebb", "text_document", "a1"]) {
      expect(Value.Check(ModelNameSchema, name)).toBe(true);
    }
  });

  it("rejects an empty name or one containing a slash", () => {
    for (const name of ["", "todo/title", "/todo", "todo/"]) {
      expect(Value.Check(ModelNameSchema, name)).toBe(false);
    }
  });
});

describe("UpdateMethodSchema", () => {
  it("accepts the five methods", () => {
    for (const method of ["create", "merge", "replace", "drop", "delete"]) {
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

  it("accepts a create naming a model and its creation HLC", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        model: "todo",
        method: "create",
        hlc: "1234567890123",
        data: null,
      }),
    ).toBe(true);
  });

  it("rejects a create that names a component", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        component: "todo/title",
        model: "todo",
        method: "create",
        hlc: "1234567890123",
        data: null,
      }),
    ).toBe(false);
  });

  it("rejects a create without a model", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        method: "create",
        hlc: "1234567890123",
        data: null,
      }),
    ).toBe(false);
  });

  it("rejects a create without its creation HLC", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        model: "todo",
        method: "create",
        data: null,
      }),
    ).toBe(false);
  });

  it("rejects a create carrying component data", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        model: "todo",
        method: "create",
        hlc: "1234567890123",
        data: leaf,
      }),
    ).toBe(false);
  });

  it("rejects the old frame in which a create spelled no model and no HLC", () => {
    expect(
      Value.Check(UpdateSchema, {
        id: "u_testid",
        subject_id: "a_actor",
        method: "create",
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

  it("accepts an unstamped create", () => {
    expect(
      Value.Check(UpdateInputSchema, {
        subject_id: "a_actor",
        model: "todo",
        method: "create",
        hlc: "1234567890123",
        data: null,
      }),
    ).toBe(true);
  });

  it("rejects an unstamped create missing its model", () => {
    expect(
      Value.Check(UpdateInputSchema, {
        subject_id: "a_actor",
        method: "create",
        hlc: "1234567890123",
        data: null,
      }),
    ).toBe(false);
  });
});

describe("row-scoped and component-scoped updates", () => {
  const create: Update = {
    id: "u_create",
    subject_id: "a_actor",
    model: "todo",
    method: "create",
    hlc: "1234567890123",
    data: null,
  };
  const merge: Update = {
    id: "u_merge",
    subject_id: "a_actor",
    component: "todo/title",
    method: "merge",
    data: leaf,
  };
  const drop: Update = {
    id: "u_drop",
    subject_id: "a_actor",
    component: "todo/title",
    method: "drop",
    data: null,
  };
  const del: Update = { id: "u_delete", subject_id: "a_actor", method: "delete", data: null };

  it("isRowCreate narrows only the create", () => {
    expect(isRowCreate(create)).toBe(true);
    for (const update of [merge, drop, del]) expect(isRowCreate(update)).toBe(false);
    if (isRowCreate(create)) expect(create.model).toBe("todo");
  });

  it("isComponentUpdate names the three component methods", () => {
    expect(isComponentUpdate(merge)).toBe(true);
    expect(isComponentUpdate(drop)).toBe(true);
    expect(isComponentUpdate(create)).toBe(false);
    expect(isComponentUpdate(del)).toBe(false);
    if (isComponentUpdate(merge)) expect(merge.component).toBe("todo/title");
  });

  it("updateComponentValue answers only for a written component", () => {
    expect(updateComponentValue(merge)).toEqual(leaf);
    for (const update of [drop, create, del]) expect(updateComponentValue(update)).toBeUndefined();
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

  it("accepts an action whose only update is a zero-component create", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: 5,
      updates: [
        {
          id: "u_upd1",
          subject_id: "a_target",
          model: "todo",
          method: "create",
          hlc: "123456789",
          data: null,
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
