import { describe, expect, it } from "vitest";
import { makeHlc } from "@ebbjs/core";
import type { StorageAdapter } from "../types/storage-adapter";
import { buildOutboxConflict, buildPatchAction, buildPutAction } from "./fixtures";

export interface AdapterTestSuiteOptions {
  name: string;
  factory: () => Promise<StorageAdapter> | StorageAdapter;
}

/**
 * The adapter-level suite covers the composition: the wiring this adapter adds
 * on top of stores that already have their own suites. A store the adapter
 * exposes by reference (`entities`, `cursors`, `outbox`, `replica`) is covered
 * by its own suite and is not retested here.
 */
export const defineAdapterTests = ({ name, factory }: AdapterTestSuiteOptions): void => {
  describe(`${name} StorageAdapter`, () => {
    describe("actions.append", () => {
      it("stores action", async () => {
        const adapter = await factory();
        const action = buildPutAction();
        await adapter.actions.append(action);

        const actions = await adapter.actions.getAll();
        expect(actions).toEqual([action]);
      });

      it("marks affected entities dirty", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        const dirty = await adapter.isDirty("todo_1");
        expect(dirty).toBe(true);
      });
    });

    describe("entities.get", () => {
      it("materializes dirty entity on get", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());

        // Composition: the entity store must read the log `append` wrote and
        // see the dirty mark it set.
        const entity = await adapter.entities.get("todo_1");
        expect(entity).not.toBe(null);
        expect(entity!.id).toBe("todo_1");
        expect(entity!.type).toBe("todo");
      });
    });

    describe("dirtyTracker direct API", () => {
      it("clear removes dirty flag without touching action log", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.dirtyTracker.clear("todo_1");
        expect(await adapter.isDirty("todo_1")).toBe(false);

        const actions = await adapter.actions.getAll();
        expect(actions).toHaveLength(1);
      });
    });

    describe("reset", () => {
      it("clears the log, the dirty set, the entities, and every group cursor", async () => {
        const adapter = await factory();
        await adapter.actions.append(buildPutAction());
        // Materialize a row first, so the entity store holds something to clear.
        await adapter.entities.get("todo_1");
        await adapter.actions.append(buildPatchAction());
        await adapter.cursors.set("group_1", 100);
        await adapter.cursors.setRecord("group_2", { seed: { group_id: "group_2", w: 3 } });
        expect(await adapter.isDirty("todo_1")).toBe(true);

        await adapter.reset();

        expect(await adapter.actions.getAll()).toEqual([]);
        expect(await adapter.isDirty("todo_1")).toBe(false);
        expect(await adapter.entities.get("todo_1")).toBe(null);
        expect((await adapter.cursors.records()).size).toBe(0);
      });
    });

    describe("actions.appendMany", () => {
      it("appends a page and marks every subject dirty", async () => {
        const adapter = await factory();
        const entries = await adapter.actions.appendMany([buildPutAction(), buildPatchAction()]);

        expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
        expect(await adapter.isDirty("todo_1")).toBe(true);
        expect((await adapter.entities.get("todo_1"))?.data.fields.title).toBeDefined();
      });
    });

    describe("outbox conflicts", () => {
      it("stores a conflicted entry and keeps it across a reset", async () => {
        const adapter = await factory();
        const entry = {
          action: buildPutAction(),
          status: "conflicted" as const,
          enqueuedAtHlc: makeHlc(1),
          basedOnGsn: 0,
          conflict: buildOutboxConflict(),
        };
        await adapter.outbox.put(entry);

        await adapter.reset();

        expect(await adapter.outbox.get("a_1")).toEqual(entry);
      });
    });
  });
};
