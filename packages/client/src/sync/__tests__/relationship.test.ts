/**
 * Tests for the relationship accessors in `relationship.ts`.
 *
 * Forward accessors (`forwardOne`, `forwardMany`) and the reverse /
 * membership walkers read through an `AdjacencyReader` — the storage
 * layer's adjacency index, not a scan of the whole `relationship` /
 * `entityGroup` type. The fake here is a small in-memory reader over
 * the same Map the old scan used, so the tests pin the traversal
 * contract and the routing key each helper asks for.
 *
 * The `Entity` shape for `Relationship` records carries
 * `{source_id, target_id, type, field}` as field values.
 */

import { describe, it, expect } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { MembershipLink, RelationshipLink } from "@ebbjs/storage/types";

import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse,
} from "../relationship";
import { buildEntityGroupDelete } from "../relationship";
import { liveMembership, readMembership } from "../entity-group";
import type { StorageAdapter } from "@ebbjs/storage/types";

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
  mkEntity(id, "relationship", {
    source_id: sourceId,
    target_id: targetId,
    field,
    type,
  });

const readLocalEntity =
  (store: Map<string, Entity>) =>
  async (id: string): Promise<Entity | null> =>
    store.get(id) ?? null;

/** The routing keys each helper asked the reader for, oldest first. */
interface ReaderCalls {
  readonly forwardLinks: string[];
  readonly reverseSourceIds: string[];
  readonly membershipsOf: string[];
}

const key = (...parts: readonly string[]): string => parts.join("|");

/**
 * An in-memory `AdjacencyReader` over the same Map the store holds.
 * Live `relationship` rows are indexed by `(field, type, source_id)`
 * forward and `(field, type, target_id)` reverse; live `entityGroup`
 * rows by `entity_id`. The calls log proves which index read ran.
 */
const mkAdjacency = (
  store: Map<string, Entity>,
): { reader: AdjacencyReader; calls: ReaderCalls } => {
  const calls: { forwardLinks: string[]; reverseSourceIds: string[]; membershipsOf: string[] } = {
    forwardLinks: [],
    reverseSourceIds: [],
    membershipsOf: [],
  };
  const live = [...store.values()].filter((e) => e.deleted_hlc === null);
  const reader: AdjacencyReader = {
    async forwardLinks({ as, type, sourceId }): Promise<readonly RelationshipLink[]> {
      calls.forwardLinks.push(key(as, type, sourceId));
      return live
        .filter(
          (e) =>
            e.type === "relationship" &&
            e.data?.fields?.["field"]?.value === as &&
            e.data?.fields?.["type"]?.value === type &&
            e.data?.fields?.["source_id"]?.value === sourceId,
        )
        .map((e) => ({
          relationshipId: e.id,
          targetId: String(e.data?.fields?.["target_id"]?.value),
        }))
        .sort((a, b) =>
          a.targetId === b.targetId
            ? a.relationshipId.localeCompare(b.relationshipId)
            : a.targetId.localeCompare(b.targetId),
        );
    },
    async reverseSourceIds({ as, type, targetId }): Promise<readonly string[]> {
      calls.reverseSourceIds.push(key(as, type, targetId));
      return [
        ...new Set(
          live
            .filter(
              (e) =>
                e.type === "relationship" &&
                e.data?.fields?.["field"]?.value === as &&
                e.data?.fields?.["type"]?.value === type &&
                e.data?.fields?.["target_id"]?.value === targetId,
            )
            .map((e) => String(e.data?.fields?.["source_id"]?.value)),
        ),
      ].sort();
    },
    async membershipsOf(entityId): Promise<readonly MembershipLink[]> {
      calls.membershipsOf.push(entityId);
      return live
        .filter(
          (e) => e.type === "entityGroup" && e.data?.fields?.["entity_id"]?.value === entityId,
        )
        .map((e) => ({
          membershipId: e.id,
          groupId: String(e.data?.fields?.["group_id"]?.value),
        }))
        .sort((a, b) =>
          a.groupId === b.groupId
            ? a.membershipId.localeCompare(b.membershipId)
            : a.groupId.localeCompare(b.groupId),
        );
    },
  };
  return { reader, calls };
};

const shape = (props: Record<string, unknown>): never =>
  ({ type: "object", properties: props }) as never;

describe("forwardOne", () => {
  it("resolves the target entity when a Relationship edge exists", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("l1", mkEntity("l1", "list", { name: "Work" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    const { reader, calls } = mkAdjacency(store);
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
    expect(calls.forwardLinks).toEqual([key("parentList", "todo", "t1")]);
  });

  it("returns undefined when the source row is missing", async () => {
    const store = new Map<string, Entity>();
    const { reader } = mkAdjacency(store);
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
    const { reader } = mkAdjacency(store);
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
    const { reader, calls } = mkAdjacency(store);
    const got = await forwardOne(
      readLocalEntity(store),
      reader,
      "t1",
      "todo",
      "parentList",
      "todo",
    );
    expect(got).toBeNull();
    expect(calls.forwardLinks).toEqual([key("parentList", "todo", "t1")]);
  });

  it("returns undefined when the edge exists but the target is missing (dangling)", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("rel-1", mkRel("rel-1", "t1", "ghost", "parentList", "todo"));
    const { reader } = mkAdjacency(store);
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
    const { reader, calls } = mkAdjacency(store);
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
    expect(calls.forwardLinks).toEqual([key("tags", "tag", "t1")]);
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
    const { reader } = mkAdjacency(store);
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
    const { reader } = mkAdjacency(store);
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
    const { reader } = mkAdjacency(store);
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

describe("buildEntityGroupDelete", () => {
  it("builds a delete Update naming only the membership row id", () => {
    const update = buildEntityGroupDelete({ membershipId: "eg_1", updateId: "u_1" });
    expect(update).toEqual({
      id: "u_1",
      subject_id: "eg_1",
      subject_type: "entityGroup",
      method: "delete",
      data: null,
    });
  });
});

describe("liveMembership", () => {
  it("carries the row id alongside the entity and group ids", () => {
    const row = mkEntity("eg_1", "entityGroup", { entity_id: "t1", group_id: "g1" });
    expect(liveMembership(row)).toEqual({ membershipId: "eg_1", entityId: "t1", groupId: "g1" });
  });

  it("returns null for a tombstoned membership row", () => {
    const row = mkEntity("eg_1", "entityGroup", { entity_id: "t1", group_id: "g1" }, "9");
    expect(liveMembership(row)).toBeNull();
  });

  it("returns null when a required id is missing", () => {
    const row = mkEntity("eg_1", "entityGroup", { entity_id: "t1" });
    expect(liveMembership(row)).toBeNull();
  });
});

describe("readMembership", () => {
  const storageWith = (rows: readonly Entity[]): StorageAdapter =>
    ({
      entities: {
        get: async (id: string) => rows.find((row) => row.id === id) ?? null,
      },
    }) as unknown as StorageAdapter;

  it("resolves a live entityGroup row by its id", async () => {
    const row = mkEntity("eg_1", "entityGroup", { entity_id: "t1", group_id: "g1" });
    await expect(readMembership(storageWith([row]), "eg_1")).resolves.toEqual({
      membershipId: "eg_1",
      entityId: "t1",
      groupId: "g1",
    });
  });

  it("returns null for a row that is not an entityGroup", async () => {
    const row = mkEntity("t1", "todo", {});
    await expect(readMembership(storageWith([row]), "t1")).resolves.toBeNull();
  });

  it("returns null for a missing row", async () => {
    await expect(readMembership(storageWith([]), "eg_1")).resolves.toBeNull();
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
    const { reader, calls } = mkAdjacency(store);
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
    expect(calls.reverseSourceIds).toEqual([key("parentList", "todo", "l1")]);
  });

  it("drops dangling sources and wrong-type entities", async () => {
    const store = new Map<string, Entity>();
    store.set("l1", mkEntity("l1", "list", {}));
    store.set("t1", mkEntity("t1", "todo", { title: "Ship" }));
    store.set("other", mkEntity("other", "user", { name: "not-a-todo" }));
    store.set("rel-1", mkRel("rel-1", "t1", "l1", "parentList", "todo"));
    store.set("rel-2", mkRel("rel-2", "other", "l1", "parentList", "todo"));
    store.set("rel-3", mkRel("rel-3", "ghost", "l1", "parentList", "todo"));
    const { reader } = mkAdjacency(store);
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
    store.set("g2", mkEntity("g2", "group", { name: "Second" }));
    store.set("g1", mkEntity("g1", "group", { name: "First" }));
    store.set("eg-1", mkEntity("eg-1", "entityGroup", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", mkEntity("eg-2", "entityGroup", { entity_id: "t1", group_id: "g2" }));
    const { reader, calls } = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      "group",
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1", "g2"]);
    expect(calls.membershipsOf).toEqual(["t1"]);
  });

  it("drops missing and wrong-type groups", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("g1", mkEntity("g1", "group", { name: "First" }));
    store.set("other", mkEntity("other", "list", {}));
    store.set("eg-1", mkEntity("eg-1", "entityGroup", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", mkEntity("eg-2", "entityGroup", { entity_id: "t1", group_id: "ghost" }));
    store.set("eg-3", mkEntity("eg-3", "entityGroup", { entity_id: "t1", group_id: "other" }));
    const { reader } = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      "group",
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1"]);
  });

  it("returns an empty list when the entity has no memberships", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    const { reader } = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      "group",
      shape({ name: { type: "string" } }),
    );
    expect(await qb).toEqual([]);
  });

  it("returns each group once when duplicate membership rows name it", async () => {
    const store = new Map<string, Entity>();
    store.set("t1", mkEntity("t1", "todo", {}));
    store.set("g1", mkEntity("g1", "group", { name: "First" }));
    store.set("eg-1", mkEntity("eg-1", "entityGroup", { entity_id: "t1", group_id: "g1" }));
    store.set("eg-2", mkEntity("eg-2", "entityGroup", { entity_id: "t1", group_id: "g1" }));
    const { reader } = mkAdjacency(store);
    const qb = membershipGroups(
      readLocalEntity(store),
      reader,
      "t1",
      "group",
      shape({ name: { type: "string" } }),
    );
    expect((await qb).map((r) => r.id)).toEqual(["g1"]);
  });
});
