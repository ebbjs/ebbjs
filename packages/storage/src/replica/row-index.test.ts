import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";

import { createRowIndex, entryOf } from "./row-index";

const leaf = (value: unknown, updateId = "u_1", ms = 1): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

const map = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

const row = (
  id: string,
  model: string,
  fields: Record<string, FieldValue>,
  overrides: Partial<Entity> = {},
): Entity => ({
  id,
  model,
  data: { fields },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
  ...overrides,
});

const link = (as: string, type: string, targetId: string): FieldValue => ({
  map: { [as]: { map: { [type]: { map: { [targetId]: leaf(true) } } } } },
});

const membership = (groupId: string, entityId: string): FieldValue => ({
  value: { group_id: groupId, entity_id: entityId },
  update_id: "u_membership",
  hlc: makeHlc(1),
});

describe("row index: entryOf", () => {
  it("keeps leaf and platform values and names a map-shaped user component without its value", () => {
    const entry = entryOf(
      row("e_1", "doc", {
        title: leaf("Hello"),
        content: map({ run_1: leaf("body") }),
        link: link("author", "wrote", "user_1"),
      }),
      { "doc/title": 2, "doc/content": 3, "ebb/link": 1 },
    );

    expect(entry.fields).toEqual({
      title: leaf("Hello"),
      link: link("author", "wrote", "user_1"),
    });
    expect(entry.components).toEqual(["doc/title", "doc/content", "ebb/link"]);
    expect(entry.versions).toEqual({ "doc/title": 2, "doc/content": 3, "ebb/link": 1 });
    expect(entry.edges).toEqual([{ as: "author", type: "wrote", targetId: "user_1" }]);
  });

  it("names a platform row's membership and carries its atomic value", () => {
    const entry = entryOf(row("m_1", "ebb", { membership: membership("grp_1", "e_1") }));

    expect(entry.membership).toEqual({ groupId: "grp_1", entityId: "e_1" });
    expect(entry.fields).toEqual({ membership: membership("grp_1", "e_1") });
  });

  it("keeps a tombstone's components and fields but contributes no edge or membership", () => {
    const entry = entryOf(
      row(
        "e_1",
        "doc",
        {
          title: leaf("Gone"),
          link: link("author", "wrote", "user_1"),
          membership: membership("grp_1", "e_1"),
        },
        { deleted_hlc: makeHlc(9) },
      ),
    );

    expect(entry.deleted).toBe(true);
    expect(entry.deletedHlc).toBe(makeHlc(9));
    expect(entry.components).toEqual(["doc/title", "ebb/link", "doc/membership"]);
    expect(Object.keys(entry.fields)).toEqual(["title", "link", "membership"]);
    expect(entry.edges).toEqual([]);
    expect(entry.membership).toBeNull();
  });
});

describe("row index: lookups", () => {
  it("answers model, component, edge, group and entity reads ascending", () => {
    const index = createRowIndex();
    index.set(
      entryOf(
        row("src_2", "page", {
          link: {
            map: {
              author: { map: { wrote: { map: { tgt_2: leaf(true), tgt_1: leaf(true) } } } },
            },
          },
        }),
      ),
    );
    index.set(entryOf(row("src_1", "page", { link: link("author", "wrote", "tgt_1") })));
    index.set(entryOf(row("m_1", "ebb", { membership: membership("grp_1", "e_2") })));
    index.set(entryOf(row("m_2", "ebb", { membership: membership("grp_1", "e_1") })));

    expect(index.idsOfModel("page")).toEqual(["src_1", "src_2"]);
    expect(index.idsOfModel("missing")).toEqual([]);
    expect(index.idsWithComponent("ebb/link")).toEqual(["src_1", "src_2"]);
    expect(index.edgeSources("author", "wrote", "tgt_1")).toEqual(["src_1", "src_2"]);
    expect(index.edgeTargets("author", "wrote", "src_2")).toEqual(["tgt_1", "tgt_2"]);
    expect(index.groupMembers("grp_1")).toEqual(["e_1", "e_2"]);
    expect(index.entityGroups("e_1")).toEqual(["grp_1"]);
    expect(index.membershipRows("e_1")).toEqual([{ membershipId: "m_2", groupId: "grp_1" }]);
    expect(index.entries().map((entry) => entry.id)).toEqual(["m_1", "m_2", "src_1", "src_2"]);
  });

  it("deduplicates ids two membership rows file under the same group", () => {
    const index = createRowIndex();
    index.set(entryOf(row("m_1", "ebb", { membership: membership("grp_1", "e_1") })));
    index.set(entryOf(row("m_2", "ebb", { membership: membership("grp_1", "e_1") })));

    expect(index.groupMembers("grp_1")).toEqual(["e_1"]);
    expect(index.membershipRows("e_1").map((entry) => entry.membershipId)).toEqual(["m_1", "m_2"]);
  });

  it("is deterministic for a membership with several entities' rows", () => {
    const index = createRowIndex();
    index.set(entryOf(row("m_b", "ebb", { membership: membership("grp_b", "e_1") })));
    index.set(entryOf(row("m_a", "ebb", { membership: membership("grp_a", "e_1") })));

    expect(index.membershipRows("e_1")).toEqual([
      { membershipId: "m_a", groupId: "grp_a" },
      { membershipId: "m_b", groupId: "grp_b" },
    ]);
  });
});

describe("row index: set diffs", () => {
  it("moves a row between models and component sets in one set", () => {
    const index = createRowIndex();
    index.set(entryOf(row("e_1", "todo", { title: leaf("One") })));
    expect(index.idsOfModel("todo")).toEqual(["e_1"]);
    expect(index.idsWithComponent("todo/title")).toEqual(["e_1"]);

    index.set(entryOf(row("e_1", "note", { body: leaf("Two") })));

    expect(index.idsOfModel("todo")).toEqual([]);
    expect(index.idsOfModel("note")).toEqual(["e_1"]);
    expect(index.idsWithComponent("todo/title")).toEqual([]);
    expect(index.idsWithComponent("note/body")).toEqual(["e_1"]);
  });

  it("withdraws a dropped edge and a removed membership", () => {
    const index = createRowIndex();
    index.set(
      entryOf(
        row("src_1", "page", {
          link: link("author", "wrote", "tgt_1"),
          membership: membership("grp_1", "e_1"),
        }),
      ),
    );
    index.set(entryOf(row("src_1", "page", { marker: leaf(true) })));

    expect(index.edgeSources("author", "wrote", "tgt_1")).toEqual([]);
    expect(index.groupMembers("grp_1")).toEqual([]);
    expect(index.entityGroups("e_1")).toEqual([]);
  });

  it("withdraws edges and membership when a row is tombstoned but keeps its components", () => {
    const index = createRowIndex();
    index.set(
      entryOf(
        row("src_1", "page", {
          link: link("author", "wrote", "tgt_1"),
          membership: membership("grp_1", "e_1"),
        }),
      ),
    );
    index.set(
      entryOf(
        row(
          "src_1",
          "page",
          {
            link: link("author", "wrote", "tgt_1"),
            membership: membership("grp_1", "e_1"),
          },
          { deleted_hlc: makeHlc(9) },
        ),
      ),
    );

    expect(index.edgeSources("author", "wrote", "tgt_1")).toEqual([]);
    expect(index.groupMembers("grp_1")).toEqual([]);
    expect(index.idsWithComponent("ebb/link")).toEqual(["src_1"]);
    expect(index.idsOfModel("page")).toEqual(["src_1"]);
  });

  it("removes and clears every lookup", () => {
    const index = createRowIndex();
    index.set(entryOf(row("e_1", "todo", { title: leaf("One") })));
    index.remove("e_1");
    expect(index.entries()).toEqual([]);
    expect(index.idsOfModel("todo")).toEqual([]);
    expect(index.idsWithComponent("todo/title")).toEqual([]);

    index.set(entryOf(row("e_2", "todo", { title: leaf("Two") })));
    index.clear();
    expect(index.entries()).toEqual([]);
    expect(index.get("e_2")).toBeUndefined();
  });
});

describe("row index: bytes", () => {
  it("retains nothing when empty, and counts the derived maps", () => {
    const index = createRowIndex();
    expect(index.bytes()).toBe(0);

    index.set(entryOf(row("e_1", "todo", { title: leaf("One") })));
    expect(index.bytes()).toBeGreaterThan(0);
  });
});
