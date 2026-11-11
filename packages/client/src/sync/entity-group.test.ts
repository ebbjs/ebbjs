/**
 * Tests for the entity↔group membership row helpers in `entity-group.ts`:
 * narrowing a stored row to a live membership, and resolving one by id
 * through the storage adapter.
 */

import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { liveMembership, readMembership } from "./entity-group";

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
