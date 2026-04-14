import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { NanoIdSchema } from "./nanoid";
import { HLCTimestampSchema } from "./hlc";
import {
  ActionSchema,
  UpdateSchema,
  SubjectTypeSchema,
  UpdateMethodSchema,
  FieldValueSchema,
  PutDataSchema,
  PatchDataSchema,
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

describe("SubjectType", () => {
  it("accepts valid subject types", () => {
    expect(Value.Check(SubjectTypeSchema, "group")).toBe(true);
    expect(Value.Check(SubjectTypeSchema, "groupMember")).toBe(true);
    expect(Value.Check(SubjectTypeSchema, "relationship")).toBe(true);
    expect(Value.Check(SubjectTypeSchema, "customType")).toBe(true);
    expect(Value.Check(SubjectTypeSchema, "entity1")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(Value.Check(SubjectTypeSchema, "")).toBe(false);
  });
});

describe("UpdateMethod", () => {
  it("accepts valid update methods", () => {
    expect(Value.Check(UpdateMethodSchema, "put")).toBe(true);
    expect(Value.Check(UpdateMethodSchema, "patch")).toBe(true);
    expect(Value.Check(UpdateMethodSchema, "delete")).toBe(true);
  });

  it("rejects invalid update methods", () => {
    expect(Value.Check(UpdateMethodSchema, "post")).toBe(false);
    expect(Value.Check(UpdateMethodSchema, "putt")).toBe(false);
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
});

describe("PutData", () => {
  it("accepts valid put data", () => {
    expect(Value.Check(PutDataSchema, {})).toBe(true);
    expect(Value.Check(PutDataSchema, { name: { value: "test", update_id: "a_test" } })).toBe(true);
    expect(
      Value.Check(PutDataSchema, {
        field1: { value: "a", update_id: "a_test" },
        field2: { value: 1, update_id: "a_test2" },
      }),
    ).toBe(true);
  });
});

describe("PatchData", () => {
  it("accepts valid patch data", () => {
    expect(Value.Check(PatchDataSchema, {})).toBe(true);
    expect(Value.Check(PatchDataSchema, { name: { value: "test", update_id: "a_test" } })).toBe(
      true,
    );
  });
});

describe("Update", () => {
  it("accepts valid put update", () => {
    const update = {
      id: "u_testid",
      subject_id: "a_actor",
      subject_type: "group",
      method: "put",
      data: { name: { value: "test", update_id: "u_upd1" } },
    };
    expect(Value.Check(UpdateSchema, update)).toBe(true);
  });

  it("accepts valid patch update", () => {
    const update = {
      id: "u_testid",
      subject_id: "a_actor",
      subject_type: "group",
      method: "patch",
      data: { name: { value: "test", update_id: "u_upd1" } },
    };
    expect(Value.Check(UpdateSchema, update)).toBe(true);
  });

  it("accepts valid delete update", () => {
    const update = {
      id: "u_testid",
      subject_id: "a_actor",
      subject_type: "group",
      method: "delete",
      data: null,
    };
    expect(Value.Check(UpdateSchema, update)).toBe(true);
  });

  it("rejects update missing id", () => {
    const update = {
      subject_id: "a_actor",
      subject_type: "group",
      method: "put",
      data: null,
    };
    expect(Value.Check(UpdateSchema, update)).toBe(false);
  });

  it("rejects update with invalid method", () => {
    const update = {
      id: "u_testid",
      subject_id: "a_actor",
      subject_type: "group",
      method: "post",
      data: null,
    };
    expect(Value.Check(UpdateSchema, update)).toBe(false);
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
          subject_type: "group",
          method: "put",
          data: { name: { value: "test", update_id: "u_upd1" } },
        },
      ],
    };
    expect(Value.Check(ActionSchema, action)).toBe(true);
  });

  it("accepts action with multiple updates", () => {
    const action = {
      id: "a_testid",
      actor_id: "a_actorid",
      hlc: "123456789",
      gsn: 5,
      updates: [
        {
          id: "u_upd1",
          subject_id: "a_actor",
          subject_type: "group",
          method: "put",
          data: { name: { value: "test", update_id: "u_upd1" } },
        },
        {
          id: "u_upd2",
          subject_id: "a_actor",
          subject_type: "group",
          method: "patch",
          data: { desc: { value: "changed", update_id: "u_upd2" } },
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
