/**
 * Tests for the relationship accessors in `relationship.ts`.
 *
 * Forward accessors (`forwardOne`, `forwardMany`) and the reverse / membership
 * walkers read through an `AdjacencyReader` — the storage layer's adjacency
 * index, or the replica's synchronous one when the client binds it (#520) — not
 * a scan of the whole model. The fake here is a small in-memory reader, so the
 * tests pin the traversal contract.
 *
 * A link and a membership are `ebb` rows carrying one atomic component each, so
 * the fake reader gates on the component rather than on `row.type`.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { MembershipLink, RelationshipLink } from "@ebbjs/storage/types";

import { carriesComponent, EBB_MODEL_NAME, systemValue } from "@ebbjs/core";

import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse,
} from "../relationship";
import { platformEntity } from "../test-utils";

const mkEntity = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  deletedHlc: string | null = null,
): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: deletedHlc,
  last_gsn: 0,
});

const mkRel = (
  id: string,
  sourceId: string,
  targetId: string,
  field: string,
  type: string,
): Entity =>
  platformEntity(id, "link", {
    source_id: sourceId,
    target_id: targetId,
    field,
    type,
  });

const readLocalEntity =
  (store: Map<string, Entity>) =>
  async (id: string): Promise<Entity | null> =>
    store.get(id) ?? null;

/**
 * An in-memory `AdjacencyReader` over the same Map the store holds.
 * Live `relationship` rows are indexed by `(field, type, source_id)`
 * forward and `(field, type, target_id)` reverse; live `entityGroup`
 * rows by `entity_id`.
 */
const mkAdjacency = (store: Map<string, Entity>): AdjacencyReader => {
  const live = [...store.values()].filter((e) => e.deleted_hlc === null);
  const reader: AdjacencyReader = {
    async forwardLinks({ as, type, sourceId }): Promise<readonly RelationshipLink[]> {
      return live
        .filter(
          (e) =>
            carriesComponent(e, "link") &&
            systemValue(e, "link")?.["field"] === as &&
            systemValue(e, "link")?.["type"] === type &&
            systemValue(e, "link")?.["source_id"] === sourceId,
        )
        .map((e) => ({
          relationshipId: e.id,
          targetId: String(systemValue(e, "link")?.["target_id"]),
        }))
        .sort((a, b) =>
          a.targetId === b.targetId
            ? a.relationshipId.localeCompare(b.relationshipId)
            : a.targetId.localeCompare(b.targetId),
        );
    },
    async reverseSourceIds({ as, type, targetId }): Promise<readonly string[]> {
      return [
        ...new Set(
          live
            .filter(
              (e) =>
                carriesComponent(e, "link") &&
                systemValue(e, "link")?.["field"] === as &&
                systemValue(e, "link")?.["type"] === type &&
                systemValue(e, "link")?.["target_id"] === targetId,
            )
            .map((e) => String(systemValue(e, "link")?.["source_id"])),
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
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
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
    expect(got?.type).toBe("list");
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
    store.set("t1", mkEntity("t1", "user", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
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
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
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
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("rel-1", mkRel("rel-1", "t1", "ghost", "parentList", "todo"));
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
    store.set("t1", mkEntity("t1", "tag", {}));
    store.set("label-a", mkEntity("label-a", "label", { name: "a" }));
    store.set("label-b", mkEntity("label-b", "label", { name: "b" }));
    store.set("label-c", mkEntity("label-c", "label", { name: "c" }));
    store.set("rel-a", mkRel("rel-a", "t1", "label-a", "tags", "tag"));
    store.set("rel-b", mkRel("rel-b", "t1", "label-b", "tags", "tag"));
    store.set("rel-c", mkRel("rel-c", "t1", "label-c", "tags", "tag"));
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
    store.set("t1", mkEntity("t1", "tag", {}));
    store.set("label-a", mkEntity("label-a", "label", { name: "a" }));
    // Same target reached through two distinct relationship rows.
    store.set("rel-a1", mkRel("rel-a1", "t1", "label-a", "tags", "tag"));
    store.set("rel-a2", mkRel("rel-a2", "t1", "label-a", "tags", "tag"));
    // A dangling edge and an entity whose type is not the declared target.
    store.set("rel-ghost", mkRel("rel-ghost", "t1", "ghost", "tags", "tag"));
    store.set("other", mkEntity("other", "list", { name: "nope" }));
    store.set("rel-other", mkRel("rel-other", "t1", "other", "tags", "tag"));
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
    store.set("t1", mkEntity("t1", "tag", {}));
    store.set("label-a", mkEntity("label-a", "label", { name: "a" }));
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
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("t1", mkEntity("t1", "todo", { title: "Ship" }));
    store.set("t2", mkEntity("t2", "todo", { title: "Other" }));
    store.set("t3", mkEntity("t3", "todo", { title: "Off-list" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    store.set("rel-2", mkRel("rel-2", "t2", "l1", "parentList", "todo"));
    store.set("rel-3", mkRel("rel-3", "t3", "l2", "parentList", "todo"));
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

  it("drops dangling sources and wrong-type entities", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", mkEntity("l1", "list", {}));
    store.set("t1", mkEntity("t1", "todo", { title: "Ship" }));
    store.set("other", mkEntity("other", "user", { name: "not-a-todo" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    store.set("rel-2", mkRel("rel-2", "other", "l1", "parentList", "todo"));
    store.set("rel-3", mkRel("rel-3", "ghost", "l1", "parentList", "todo"));
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
    store.set("t1", mkEntity("t1", "todo", {}));
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
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("g1", platformEntity("g1", "group", { name: "First" }));
    store.set("other", mkEntity("other", "list", {}));
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
    store.set("t1", mkEntity("t1", "todo", {}));
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
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("g1", platformEntity("g1", "group", { name: "First" }));
    store.set("eg-1", platformEntity("eg-1", "membership", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", mkEntity("eg-2", "membership", { entity_id: "t1", group_id: "g1" }));
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
