import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import { accessorAffectedEntityId } from "./reverse-index";

const entity = (type: string, fields: Record<string, unknown>): Entity => ({
  id: "row_1",
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value, update_id: "u", hlc: "1-0" }]),
    ),
  },
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: null,
  last_gsn: 0,
});

describe("accessorAffectedEntityId", () => {
  it("maps a relationship row to its source", () => {
    expect(
      accessorAffectedEntityId(entity("relationship", { source_id: "todo_1", target_id: "u_1" })),
    ).toBe("todo_1");
  });

  it("maps an entityGroup row to its member entity", () => {
    expect(accessorAffectedEntityId(entity("entityGroup", { entity_id: "todo_1" }))).toBe("todo_1");
  });

  it("still maps a tombstone so an unlink / removal wakes the entity", () => {
    const removed = { ...entity("relationship", { source_id: "todo_1" }), deleted_hlc: "2-0" };
    expect(accessorAffectedEntityId(removed)).toBe("todo_1");
  });

  it("returns null for a row that affects no accessors", () => {
    expect(accessorAffectedEntityId(entity("todo", { title: "T" }))).toBeNull();
  });

  it("returns null when the mapping fields are missing or malformed", () => {
    expect(accessorAffectedEntityId(entity("relationship", { target_id: "u_1" }))).toBeNull();
    expect(accessorAffectedEntityId(entity("entityGroup", { group_id: "grp_1" }))).toBeNull();
    expect(
      accessorAffectedEntityId(entity("relationship", { source_id: { nested: true } })),
    ).toBeNull();
  });
});
