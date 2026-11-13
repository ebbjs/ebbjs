/**
 * Tests for the entity↔group membership row helpers in `entity-group.ts`:
 * narrowing a stored row to a live membership, and resolving one by id
 * through the storage adapter.
 */

import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { liveMembership, readMembership } from "./entity-group";
import { platformEntity } from "./test-utils";

const mkMembership = (
  id: string,
  entityId: string,
  groupId: string | undefined,
  deletedHlc: string | null = null,
): Entity =>
  platformEntity(
    id,
    "membership",
    groupId === undefined ? { entity_id: entityId } : { entity_id: entityId, group_id: groupId },
    deletedHlc,
  );

describe("liveMembership", () => {
  it("carries the row id alongside the entity and group ids", () => {
    const row = mkMembership("eg_1", "t1", "g1");
    expect(liveMembership(row)).toEqual({ membershipId: "eg_1", entityId: "t1", groupId: "g1" });
  });

  it("returns null for a tombstoned membership row", () => {
    const row = mkMembership("eg_1", "t1", "g1", "9");
    expect(liveMembership(row)).toBeNull();
  });

  it("returns null when a required id is missing", () => {
    const row = mkMembership("eg_1", "t1", undefined);
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

  it("resolves a live membership row by its id", async () => {
    const row = mkMembership("eg_1", "t1", "g1");
    await expect(readMembership(storageWith([row]), "eg_1")).resolves.toEqual({
      membershipId: "eg_1",
      entityId: "t1",
      groupId: "g1",
    });
  });

  it("returns null for a row that carries no ebb/membership component", async () => {
    const row: Entity = {
      id: "eg_1",
      type: "todo",
      data: { fields: { title: { value: "Ship", update_id: "u" } } },
      exists: true,
      created_hlc: "1",
      updated_hlc: "1",
      deleted_hlc: null,
      last_gsn: 0,
    };
    await expect(readMembership(storageWith([row]), "eg_1")).resolves.toBeNull();
  });

  it("returns null for a missing row", async () => {
    await expect(readMembership(storageWith([]), "eg_1")).resolves.toBeNull();
  });
});
