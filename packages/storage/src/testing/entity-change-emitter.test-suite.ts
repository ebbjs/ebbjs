import { describe, expect, it } from "vitest";
import type { Entity } from "@ebbjs/core";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import type { StorageAdapter } from "../types/storage-adapter";
import { buildPatchAction, buildPutAction } from "./fixtures";

/**
 * EntityChangeEmitter — contract that every adapter-backed emitter
 * honors. The shared suite wires a fresh adapter per test so listeners
 * don't bleed between cases (the emitter must be torn down with the
 * adapter).
 */
export interface EntityChangeEmitterTestSuiteOptions {
  name: string;
  factory: () =>
    | Promise<{
        adapter: StorageAdapter;
        emitter: EntityChangeEmitter;
      }>
    | {
        adapter: StorageAdapter;
        emitter: EntityChangeEmitter;
      };
}

const makeEntity = (overrides: Partial<Entity> = {}): Entity => ({
  id: "todo_2",
  type: "todo",
  data: { fields: { title: { value: "Direct", update_id: "u_direct", hlc: "1-0" } } },
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: null,
  last_gsn: 0,
  ...overrides,
});

const makeRelationship = (overrides: Partial<Entity> = {}): Entity =>
  makeEntity({
    id: "rel_1",
    type: "relationship",
    data: {
      fields: {
        source_id: { value: "todo_1", update_id: "u_rel", hlc: "1-0" },
        target_id: { value: "user_1", update_id: "u_rel", hlc: "1-0" },
        type: { value: "todo", update_id: "u_rel", hlc: "1-0" },
        field: { value: "owner", update_id: "u_rel", hlc: "1-0" },
      },
    },
    ...overrides,
  });

const makeMembership = (overrides: Partial<Entity> = {}): Entity =>
  makeEntity({
    id: "eg_1",
    type: "entityGroup",
    data: {
      fields: {
        entity_id: { value: "todo_1", update_id: "u_eg", hlc: "1-0" },
        group_id: { value: "grp_1", update_id: "u_eg", hlc: "1-0" },
      },
    },
    ...overrides,
  });

export const defineEntityChangeEmitterTests = ({
  name,
  factory,
}: EntityChangeEmitterTestSuiteOptions): void => {
  describe(`${name} EntityChangeEmitter`, () => {
    describe("onEntityChange", () => {
      it("fires after the entity is materialized on get", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());

        const seen: (Entity | null)[] = [];
        const unsub = emitter.onEntityChange("todo_1", (e) => seen.push(e));

        const entity = await adapter.entities.get("todo_1");
        expect(entity).not.toBeNull();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe("todo_1");
        unsub();
      });

      it("does not fire for a get() that finds no dirty entity (already materialized)", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());
        // First get materializes.
        await adapter.entities.get("todo_1");

        const seen: (Entity | null)[] = [];
        const unsub = emitter.onEntityChange("todo_1", (e) => seen.push(e));
        // Second get finds no dirty flag → no materialize → no emit.
        await adapter.entities.get("todo_1");
        expect(seen).toEqual([]);
        unsub();
      });

      it("fires again on subsequent materializations (new patch after a put)", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());
        await adapter.entities.get("todo_1");

        const seen: (Entity | null)[] = [];
        const unsub = emitter.onEntityChange("todo_1", (e) => seen.push(e));

        await adapter.actions.append(buildPatchAction());
        await adapter.entities.get("todo_1");
        expect(seen).toHaveLength(1);
        // The patch updated the title.
        const entity = seen[0];
        const title = entity?.data?.fields?.["title"];
        expect((title as { value: unknown } | undefined)?.value).toBe("Updated");
        unsub();
      });

      it("unsub stops further emissions", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());

        const seen: (Entity | null)[] = [];
        const unsub = emitter.onEntityChange("todo_1", (e) => seen.push(e));
        await adapter.entities.get("todo_1");
        expect(seen).toHaveLength(1);

        unsub();
        await adapter.actions.append(buildPatchAction());
        await adapter.entities.get("todo_1");
        expect(seen).toHaveLength(1);
      });

      it("fires on set() — direct entity write bypasses materialization", async () => {
        const { adapter, emitter } = await factory();

        const seen: (Entity | null)[] = [];
        const unsub = emitter.onEntityChange("todo_2", (e) => seen.push(e));
        await adapter.entities.set(makeEntity({ id: "todo_2", type: "todo" }));
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe("todo_2");
        unsub();
      });
    });

    describe("onTypeChange", () => {
      it("fires once per affected entity on a query() materialization sweep", async () => {
        const { adapter, emitter } = await factory();
        // Two actions, each materializing one todo.
        await adapter.actions.append(buildPutAction());
        await adapter.actions.append(buildPutAction());

        const seen: Entity[] = [];
        const unsub = emitter.onTypeChange("todo", (e) => seen.push(e));
        await adapter.entities.query("todo");
        // query() materializes all dirty ids; the type listener fires once per id.
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe("todo_1");
        unsub();
      });

      it("does not fire for ids that were already materialized", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());
        await adapter.entities.get("todo_1");

        const seen: Entity[] = [];
        const unsub = emitter.onTypeChange("todo", (e) => seen.push(e));
        await adapter.entities.query("todo");
        expect(seen).toEqual([]);
        unsub();
      });

      it("fires for the id even when the type listener was registered after the action", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());

        const seen: Entity[] = [];
        const unsub = emitter.onTypeChange("todo", (e) => seen.push(e));
        await adapter.entities.query("todo");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe("todo_1");
        unsub();
      });
    });

    describe("onAccessorChange", () => {
      it("fires for a relationship row's source on set", async () => {
        const { adapter, emitter } = await factory();
        const seen: string[] = [];
        const unsub = emitter.onAccessorChange("todo_1", () => seen.push("todo_1"));
        await adapter.entities.set(makeRelationship());
        expect(seen).toEqual(["todo_1"]);
        unsub();
      });

      it("fires for a relationship tombstone so an unlink still wakes the source", async () => {
        const { adapter, emitter } = await factory();
        const relationship = makeRelationship();
        await adapter.entities.set(relationship);

        const seen: string[] = [];
        const unsub = emitter.onAccessorChange("todo_1", () => seen.push("todo_1"));
        await adapter.entities.set({ ...relationship, deleted_hlc: "2-0" });
        expect(seen).toEqual(["todo_1"]);
        unsub();
      });

      it("fires for an entityGroup row's entity", async () => {
        const { adapter, emitter } = await factory();
        const seen: string[] = [];
        const unsub = emitter.onAccessorChange("todo_1", () => seen.push("todo_1"));
        await adapter.entities.set(makeMembership());
        expect(seen).toEqual(["todo_1"]);
        unsub();
      });

      it("does not fire for a plain entity set", async () => {
        const { adapter, emitter } = await factory();
        const seen: string[] = [];
        const unsub = emitter.onAccessorChange("todo_2", () => seen.push("todo_2"));
        await adapter.entities.set(makeEntity({ id: "todo_2", type: "todo" }));
        expect(seen).toEqual([]);
        unsub();
      });

      it("unsub stops further emissions", async () => {
        const { adapter, emitter } = await factory();
        const seen: string[] = [];
        const unsub = emitter.onAccessorChange("todo_1", () => seen.push("todo_1"));
        await adapter.entities.set(makeRelationship());
        expect(seen).toHaveLength(1);

        unsub();
        await adapter.entities.set(makeRelationship({ id: "rel_2" }));
        expect(seen).toHaveLength(1);
      });

      it("a throwing listener does not break sibling listeners", async () => {
        const { adapter, emitter } = await factory();
        const good: string[] = [];
        emitter.onAccessorChange("todo_1", () => {
          throw new Error("boom");
        });
        emitter.onAccessorChange("todo_1", () => good.push("todo_1"));
        await adapter.entities.set(makeRelationship());
        expect(good).toEqual(["todo_1"]);
      });
    });

    describe("reset", () => {
      it("clears all listeners (no further emissions after reset)", async () => {
        const { adapter, emitter } = await factory();
        const seen: (Entity | null)[] = [];
        emitter.onEntityChange("todo_1", (e) => seen.push(e));

        await adapter.reset();
        await adapter.actions.append(buildPutAction());
        await adapter.entities.get("todo_1");
        expect(seen).toEqual([]);
      });
    });

    describe("error isolation", () => {
      it("a throwing listener does not break sibling listeners", async () => {
        const { adapter, emitter } = await factory();
        await adapter.actions.append(buildPutAction());

        const good: (Entity | null)[] = [];
        emitter.onEntityChange("todo_1", () => {
          throw new Error("boom");
        });
        emitter.onEntityChange("todo_1", (e) => good.push(e));
        await adapter.entities.get("todo_1");
        expect(good).toHaveLength(1);
      });
    });
  });
};
