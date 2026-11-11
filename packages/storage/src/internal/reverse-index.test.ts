import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import {
  forwardMembershipEntryFor,
  forwardRelationshipEntryFor,
  liveMembershipLinks,
  liveRelationshipLinks,
} from "./reverse-index";

const entity = (type: string, fields: Record<string, unknown>): Entity => ({
  id: "row_1",
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value, update_id: "u", hlc: "1-0" }]),
    ),
  },
  exists: true,
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: null,
  last_gsn: 0,
});

describe("forward index entries", () => {
  it("indexes nothing for a tombstone or a row missing part of its key", () => {
    const tombstoned = {
      ...entity("relationship", { field: "list", type: "t", source_id: "s", target_id: "x" }),
      deleted_hlc: "2-0",
    };
    expect(forwardRelationshipEntryFor(tombstoned)).toBeNull();

    // A partial key must not leave a half-built entry in the index.
    expect(
      forwardRelationshipEntryFor(entity("relationship", { field: "list", source_id: "s" })),
    ).toBeNull();
    expect(
      forwardRelationshipEntryFor(
        entity("relationship", { field: "list", type: "t", source_id: "s" }),
      ),
    ).toBeNull();
    expect(
      forwardRelationshipEntryFor(
        entity("relationship", { field: "list", type: "t", source_id: "s", target_id: 7 }),
      ),
    ).toBeNull();
    expect(forwardMembershipEntryFor(entity("entityGroup", { entity_id: "todo_1" }))).toBeNull();
    expect(
      forwardRelationshipEntryFor(entity("todo", { field: "list", type: "t", source_id: "s" })),
    ).toBeNull();
  });

  it("orders live links by yielded id then row id", () => {
    // Inserted out of row-id order, so a stable sort by value alone would
    // leave `rel_c` before `rel_b`.
    expect(liveRelationshipLinks({ rel_c: "list_b", rel_a: "list_a", rel_b: "list_b" })).toEqual([
      { relationshipId: "rel_a", targetId: "list_a" },
      { relationshipId: "rel_b", targetId: "list_b" },
      { relationshipId: "rel_c", targetId: "list_b" },
    ]);
    expect(liveMembershipLinks({ eg_c: "group_b", eg_a: "group_a", eg_b: "group_b" })).toEqual([
      { membershipId: "eg_a", groupId: "group_a" },
      { membershipId: "eg_b", groupId: "group_b" },
      { membershipId: "eg_c", groupId: "group_b" },
    ]);
  });
});
