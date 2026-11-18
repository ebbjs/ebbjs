/**
 * Tests for the relationship accessors in `relationship.ts`.
 *
 * Forward accessors read the source row's own `ebb/link` component, and the
 * reverse / membership walkers read the adjacency index — the storage layer's,
 * or the replica's synchronous one when the client binds it (#520). The fake
 * here is a small in-memory reader, so the tests pin the traversal contract.
 *
 * A link is a keyed component of its source row and a membership is an `ebb`
 * row carrying one atomic component, so the fake reader gates on the component.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { MembershipLink } from "@ebbjs/storage/types";

import { carriesComponent, EBB_MODEL_NAME, linkEdges, linkTargets, systemValue } from "@ebbjs/core";

import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse,
} from "../relationship";
import { entityRow, linkRow, platformEntity } from "../test-utils";

const readLocalEntity =
  (store: Map<string, Entity>) =>
  async (id: string): Promise<Entity | null> =>
    store.get(id) ?? null;

/**
 * An in-memory `AdjacencyReader` over the same Map the store holds. Forward
 * targets come from the source row's `ebb/link` component, as the replica's
 * is a component read; the reverse direction indexes the live edges of every
 * row. Memberships are `ebb/membership` rows keyed by `entity_id`.
 */
const mkAdjacency = (store: Map<string, Entity>): AdjacencyReader => {
  const live = [...store.values()].filter((e) => e.deleted_hlc === null);
  const reader: AdjacencyReader = {
    async forwardTargets(sourceId, as, type): Promise<readonly string[]> {
      return linkTargets(store.get(sourceId), as, type);
    },
    async reverseSourceIds({ as, type, targetId }): Promise<readonly string[]> {
      return [
        ...new Set(
          live
            .filter((e) =>
              linkEdges(e).some(
                (edge) => edge.as === as && edge.type === type && edge.targetId === targetId,
              ),
            )
            .map((e) => e.id),
        ),
      ].sort();
    },
    async membershipsOf(entityId): Promise<readonly MembershipLink[]> {
      return live
        .filter((e) => carriesComponent(e, "membership"))
        .filter((e) => systemValue(e, "membership")?.["entity_id"] === entityId)
        .map((e) => ({
          membershipId: e.id,
          groupId: String(systemValue(e, "membership")?.["group_id"]),
        }))
        .sort((a, b) =>
          a.groupId === b.groupId
            ? a.membershipId.localeCompare(b.membershipId)
            : a.groupId.localeCompare(b.groupId),
        );
    },
  };
  return reader;
};

const shape = (props: Record<string, unknown>): never =>
  ({ type: "object", properties: props }) as never;

describe("forwardOne", () => {
  it("resolves the target entity when a Relationship edge exists", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", linkRow("t1", "todo", [{ as: "parentList", type: "todo", targetId: "l1" }]));
    store.set("l1", entityRow("l1", "list", { name: "Work" }));
    const reader = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got?.id).toBe("l1");
    expect(got?.model).toBe("list");
  });

  it("returns undefined when the source row is missing", async () => {
    const store = new Map<string, Entity>();
    const reader = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "missing",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });

  it("returns undefined when the source row exists but has the wrong type", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", linkRow("t1", "user", [{ as: "parentList", type: "todo", targetId: "l1" }]));
    store.set("l1", entityRow("l1", "list", { name: "Work" }));
    const reader = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });

  it("returns null when the link is cleared (no Relationship edge)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "todo", {}));
    store.set("l1", entityRow("l1", "list", { name: "Work" }));
    const reader = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeNull();
  });

  it("returns undefined when the edge exists but the target is missing (dangling)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", linkRow("t1", "todo", [{ as: "parentList", type: "todo", targetId: "ghost" }]));
    const reader = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeUndefined();
  });
});

describe("forwardMany", () => {
  it("projects the targets whose Relationship edges point at this source", async () => {
    const store = new Map<string, Entity>();
    store.set(
      "t1",
      linkRow("t1", "tag", [
        { as: "tags", type: "tag", targetId: "label-a" },
        { as: "tags", type: "tag", targetId: "label-b" },
        { as: "tags", type: "tag", targetId: "label-c" },
      ]),
    );
    store.set("label-a", entityRow("label-a", "label", { name: "a" }));
    store.set("label-b", entityRow("label-b", "label", { name: "b" }));
    store.set("label-c", entityRow("label-c", "label", { name: "c" }));
    const reader = mkAdjacency(store);
    const qb = forwardMany(
      readLocalEntity(store),
      reader,
      "t1",
      "tag",
      "label",
      shape({ name: { type: "string" } }),
      "tags",
      "tag",
    );
    const rows = await qb;
    expect(rows.map((r) => (r as unknown as { name: string }).name)).toEqual(["a", "b", "c"]);
  });

  it("dedupes repeated targets and drops wrong-type entities", async () => {
    const store = new Map<string, Entity>();
    // A dangling edge and an entity whose type is not the declared target.
    store.set(
      "t1",
      linkRow("t1", "tag", [
        { as: "tags", type: "tag", targetId: "label-a" },
        { as: "tags", type: "tag", targetId: "ghost" },
        { as: "tags", type: "tag", targetId: "other" },
      ]),
    );
    store.set("label-a", entityRow("label-a", "label", { name: "a" }));
    store.set("other", entityRow("other", "list", { name: "nope" }));
    const reader = mkAdjacency(store);
    const qb = forwardMany(
      readLocalEntity(store),
      reader,
      "t1",
      "tag",
      "label",
      shape({ name: { type: "string" } }),
      "tags",
      "tag",
    );
    const rows = await qb;
    expect(rows.map((r) => r.id)).toEqual(["label-a"]);
  });

  it("returns an empty list when the source is missing", async () => {
    const store = new Map<string, Entity>();
    const reader = mkAdjacency(store);
    const qb = forwardMany(
      readLocalEntity(store),
      reader,
      "missing",
      "tag",
      "label",
      shape({ name: { type: "string" } }),
      "tags",
      "tag",
    );
    expect(await qb).toEqual([]);
  });

  it("returns an empty list when no Relationship edges exist", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "tag", {}));
    store.set("label-a", entityRow("label-a", "label", { name: "a" }));
    const reader = mkAdjacency(store);
    const qb = forwardMany(
      readLocalEntity(store),
      reader,
      "t1",
      "tag",
      "label",
      shape({ name: { type: "string" } }),
      "tags",
      "tag",
    );
    expect(await qb).toEqual([]);
  });
});

describe("reverse", () => {
  it("projects sources that point at the target through the reverse index", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", entityRow("l1", "list", { name: "Work" }));
    store.set(
      "t1",
      linkRow("t1", "todo", [{ as: "parentList", type: "todo", targetId: "l1" }], {
        title: "Ship",
      }),
    );
    store.set(
      "t2",
      linkRow("t2", "todo", [{ as: "parentList", type: "todo", targetId: "l1" }], {
        title: "Other",
      }),
    );
    store.set(
      "t3",
      linkRow("t3", "todo", [{ as: "parentList", type: "todo", targetId: "l2" }], {
        title: "Off-list",
      }),
    );
    const reader = mkAdjacency(store);
    const qb = reverse(
      readLocalEntity(store),
      reader,
      "l1",
      "todo",
      shape({ title: { type: "string" } }),
      "parentList",
      "todo",
    );
    const rows = await qb;
    expect(rows.map((r) => (r as unknown as { title: string }).title)).toEqual(["Ship", "Other"]);
  });

  it("drops a source of another model", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", entityRow("l1", "list", {}));
    store.set(
      "t1",
      linkRow("t1", "todo", [{ as: "parentList", type: "todo", targetId: "l1" }], {
        title: "Ship",
      }),
    );
    store.set(
      "other",
      linkRow("other", "user", [{ as: "parentList", type: "todo", targetId: "l1" }], {
        name: "not-a-todo",
      }),
    );

    const reader = mkAdjacency(store);
    const qb = reverse(
      readLocalEntity(store),
      reader,
      "l1",
      "todo",
      shape({ title: { type: "string" } }),
      "parentList",
      "todo",
    );
    expect((await qb).map((r) => r.id)).toEqual(["t1"]);
  });
});

describe("membershipGroups", () => {
  it("projects the groups an entity is filed into, ascending by group id", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "todo", {}));
    store.set("g2", platformEntity("g2", "group", { name: "Second" }));
    store.set("g1", platformEntity("g1", "group", { name: "First" }));
    store.set("eg-1", platformEntity("eg-1", "membership", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", platformEntity("eg-2", "membership", { entity_id: "t1", group_id: "g2" }));
    const reader = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      EBB_MODEL_NAME,
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1", "g2"]);
  });

  it("drops missing and wrong-type groups", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "todo", {}));
    store.set("g1", platformEntity("g1", "group", { name: "First" }));
    store.set("other", entityRow("other", "list", {}));
    store.set("eg-1", platformEntity("eg-1", "membership", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", platformEntity("eg-2", "membership", { entity_id: "t1", group_id: "ghost" }));
    store.set("eg-3", platformEntity("eg-3", "membership", { entity_id: "t1", group_id: "other" }));
    const reader = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      EBB_MODEL_NAME,
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1"]);
  });

  it("returns an empty list when the entity has no memberships", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "todo", {}));
    const reader = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      EBB_MODEL_NAME,
      shape({ name: { type: "string" } }),
    );
    expect(await qb).toEqual([]);
  });

  it("returns each group once when duplicate membership rows name it", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", entityRow("t1", "todo", {}));
    store.set("g1", platformEntity("g1", "group", { name: "First" }));
    store.set("eg-1", platformEntity("eg-1", "membership", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", entityRow("eg-2", "membership", { entity_id: "t1", group_id: "g1" }));
    const reader = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      EBB_MODEL_NAME,
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1"]);
  });
});
