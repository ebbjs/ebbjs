import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import {
  accessorAffectedEntityId,
  forwardIndexKey,
  forwardMembershipEntryFor,
  forwardMembershipIndexKey,
  forwardRelationshipEntryFor,
  liveMembershipLinks,
  liveRelationshipLinks,
  reverseIndexKey,
} from "./reverse-index";

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

describe("forward index entries", () => {
  it("keys a relationship row by source and yields its target", () => {
    expect(
      forwardRelationshipEntryFor(
        entity("relationship", {
          field: "list",
          type: "todo_list",
          source_id: "todo_1",
          target_id: "list_1",
        }),
      ),
    ).toEqual({
      key: forwardIndexKey("list", "todo_list", "todo_1"),
      rowId: "row_1",
      value: "list_1",
    });
  });

  it("keys a membership row by member entity and yields its group", () => {
    expect(
      forwardMembershipEntryFor(entity("entityGroup", { entity_id: "todo_1", group_id: "grp_1" })),
    ).toEqual({ key: forwardMembershipIndexKey("todo_1"), rowId: "row_1", value: "grp_1" });
  });

  it("skips tombstones and malformed rows", () => {
    const tombstoned = {
      ...entity("relationship", { field: "list", type: "t", source_id: "s", target_id: "x" }),
      deleted_hlc: "2-0",
    };
    expect(forwardRelationshipEntryFor(tombstoned)).toBeNull();
    expect(
      forwardRelationshipEntryFor(entity("relationship", { field: "list", target_id: "x" })),
    ).toBeNull();
  });

  it("keeps a forward key out of the reverse key space for the same ids", () => {
    expect(forwardIndexKey("list", "todo_list", "x")).not.toBe(
      reverseIndexKey("list", "todo_list", "x"),
    );
  });

  it("orders live links by yielded id then row id", () => {
    expect(
      liveRelationshipLinks({
        rel_b: "list_b",
        rel_a: "list_a",
        rel_b2: "list_b",
      }),
    ).toEqual([
      { relationshipId: "rel_a", targetId: "list_a" },
      { relationshipId: "rel_b", targetId: "list_b" },
      { relationshipId: "rel_b2", targetId: "list_b" },
    ]);
    expect(liveMembershipLinks({ eg_1: "group_1" })).toEqual([
      { membershipId: "eg_1", groupId: "group_1" },
    ]);
  });
});
