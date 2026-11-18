import { describe, expect, it } from "vitest";
import type { Entity, FieldValue } from "@ebbjs/core";
import {
  forwardIndexEntriesFor,
  forwardMembershipEntryFor,
  indexEntriesFor,
  liveMembershipLinks,
  membershipEntryFor,
  relationshipEntriesFor,
} from "./reverse-index";

const leaf = (value: unknown): FieldValue => ({ value, update_id: "u", hlc: "1-0" });

const entity = (fields: Record<string, FieldValue>, model = "ebb"): Entity => ({
  id: "row_1",
  model,
  data: { fields },
  exists: true,
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: null,
  last_gsn: 0,
});

/**
 * The `ebb/link` value carrying one edge per `(as, type, target)`. A target of
 * `null` is a tombstone, which is a removed edge rather than a live one.
 */
const linkValue = (
  edges: readonly { as: string; type: string; targetId: string; present?: boolean }[],
): FieldValue => {
  const byAs: Record<string, Record<string, Record<string, FieldValue>>> = {};
  for (const edge of edges) {
    const byType = (byAs[edge.as] ??= {});
    const byTarget = (byType[edge.type] ??= {});
    byTarget[edge.targetId] = leaf(edge.present === false ? null : true);
  }
  return {
    map: Object.fromEntries(
      Object.entries(byAs).map(([as, byType]) => [
        as,
        {
          map: Object.fromEntries(
            Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
          ),
        },
      ]),
    ),
  };
};

const membershipValue = (overrides: Record<string, unknown> = {}): FieldValue =>
  leaf({ entity_id: "todo_1", group_id: "group_1", ...overrides });

describe("reverse index entries", () => {
  it("keys one entry per live edge on the row that carries it", () => {
    expect(
      relationshipEntriesFor(
        entity(
          {
            link: linkValue([
              { as: "list", type: "todo_list", targetId: "x" },
              { as: "list", type: "todo_list", targetId: "y" },
            ]),
          },
          "todo",
        ),
      ),
    ).toEqual([
      { key: "list\u0000todo_list\u0000x", id: "row_1", value: "row_1" },
      { key: "list\u0000todo_list\u0000y", id: "row_1", value: "row_1" },
    ]);
  });

  it("indexes nothing for a tombstone or a tombstoned key", () => {
    const tombstoned = {
      ...entity({ link: linkValue([{ as: "list", type: "t", targetId: "x" }]) }),
      deleted_hlc: "2-0",
    };
    expect(relationshipEntriesFor(tombstoned)).toEqual([]);

    expect(
      relationshipEntriesFor(
        entity({
          link: linkValue([{ as: "list", type: "t", targetId: "x", present: false }]),
        }),
      ),
    ).toEqual([]);
  });

  it("indexes nothing for a row carrying no link component", () => {
    expect(relationshipEntriesFor(entity({ list: linkValue([]) }, "todo"))).toEqual([]);
    expect(relationshipEntriesFor(entity({ link: leaf(true) }, "todo"))).toEqual([]);
  });

  it("keys a membership row under the membership component's key space", () => {
    expect(membershipEntryFor(entity({ membership: membershipValue() }))).toEqual({
      key: "groups\u0000ebb/membership\u0000group_1",
      id: "row_1",
      value: "todo_1",
    });
  });

  it("derives one entry per component a row carries", () => {
    // A row carrying both kinds is the overlay case (#820): an `ebb/link`
    // component on a row that is also a membership.
    const both = entity({
      link: linkValue([{ as: "list", type: "t", targetId: "x" }]),
      membership: membershipValue(),
    });
    expect(indexEntriesFor(both).map((entry) => entry.key)).toEqual([
      "list\u0000t\u0000x",
      "groups\u0000ebb/membership\u0000group_1",
    ]);
    expect(forwardIndexEntriesFor(both).map((entry) => entry.key)).toEqual([
      "\u0001groups\u0000ebb/membership\u0000todo_1",
    ]);
  });

  it("derives no entry for a row carrying neither platform component", () => {
    const todo = entity({ title: leaf("Hello") }, "todo");
    expect(indexEntriesFor(todo)).toEqual([]);
    expect(forwardIndexEntriesFor(todo)).toEqual([]);
  });
});

describe("live index reads", () => {
  it("orders live membership links by yielded id then row id", () => {
    expect(liveMembershipLinks({ eg_c: "group_b", eg_a: "group_a", eg_b: "group_b" })).toEqual([
      { membershipId: "eg_a", groupId: "group_a" },
      { membershipId: "eg_b", groupId: "group_b" },
      { membershipId: "eg_c", groupId: "group_b" },
    ]);
  });

  it("keys a membership entry on its row, not on its member", () => {
    const duplicate = entity({ membership: membershipValue() });
    expect(forwardMembershipEntryFor(duplicate)?.id).toBe("row_1");
  });
});
