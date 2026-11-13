import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import {
  forwardIndexEntriesFor,
  forwardMembershipEntryFor,
  forwardRelationshipEntryFor,
  indexEntriesFor,
  liveMembershipLinks,
  liveRelationshipLinks,
  membershipEntryFor,
  relationshipEntryFor,
} from "./reverse-index";

const entity = (fields: Record<string, unknown>, type = "ebb"): Entity => ({
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

const linkValue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source_id: "s",
  target_id: "x",
  type: "t",
  field: "list",
  ...overrides,
});

const membershipValue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  entity_id: "todo_1",
  group_id: "group_1",
  ...overrides,
});

describe("forward index entries", () => {
  it("indexes nothing for a tombstone or a row missing part of its key", () => {
    const tombstoned = {
      ...entity({ link: linkValue() }),
      deleted_hlc: "2-0",
    };
    expect(forwardRelationshipEntryFor(tombstoned)).toBeNull();

    // A partial key must not leave a half-built entry in the index.
    expect(forwardRelationshipEntryFor(entity({ link: linkValue({ target_id: undefined }) }))).toBe(
      null,
    );
    expect(forwardRelationshipEntryFor(entity({ link: linkValue({ source_id: 7 }) }))).toBeNull();
    expect(
      forwardMembershipEntryFor(entity({ membership: membershipValue({ entity_id: undefined }) })),
    ).toBeNull();
    // A user row carrying no platform component indexes nothing.
    expect(forwardRelationshipEntryFor(entity({ list: linkValue() }, "todo"))).toBeNull();
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

  it("keys a link on its value, not on the row model", () => {
    expect(relationshipEntryFor(entity({ link: linkValue() }))).toEqual({
      key: "list\u0000t\u0000x",
      rowId: "row_1",
      value: "s",
    });
  });

  it("keys a membership row under the membership component's key space", () => {
    expect(membershipEntryFor(entity({ membership: membershipValue() }))).toEqual({
      key: "groups\u0000ebb/membership\u0000group_1",
      rowId: "row_1",
      value: "todo_1",
    });
  });

  it("derives one entry per component a row carries", () => {
    // One row carrying both kinds is impossible in slice 10, but a row is not
    // assumed to carry only one: the overlay case (#820) puts both on one row.
    const both = entity({ link: linkValue(), membership: membershipValue() });
    expect(indexEntriesFor(both).map((entry) => entry.key)).toEqual([
      "list\u0000t\u0000x",
      "groups\u0000ebb/membership\u0000group_1",
    ]);
    expect(forwardIndexEntriesFor(both).map((entry) => entry.key)).toEqual([
      "\u0001list\u0000t\u0000s",
      "\u0001groups\u0000ebb/membership\u0000todo_1",
    ]);
  });

  it("derives no entry for a row carrying neither platform component", () => {
    const todo = entity({ title: "Hello" }, "todo");
    expect(indexEntriesFor(todo)).toEqual([]);
    expect(forwardIndexEntriesFor(todo)).toEqual([]);
  });
});
