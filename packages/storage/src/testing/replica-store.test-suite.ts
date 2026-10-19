import { describe, expect, it } from "vitest";
import { makeHlc } from "@ebbjs/core";
import type { ReplicaRecord, ReplicaStore } from "../types/replica-store";
import { buildTodoEntity, HLC_BASE } from "./fixtures";

export interface ReplicaStoreTestSuiteOptions {
  name: string;
  factory: () => Promise<ReplicaStore> | ReplicaStore;
}

const buildRecord = (overrides: Partial<ReplicaRecord> = {}): ReplicaRecord => ({
  format: 1,
  position: 7,
  revision: 3,
  entities: [
    buildTodoEntity("todo_1", "Hello", makeHlc(HLC_BASE)),
    buildTodoEntity("todo_2", "World", makeHlc(HLC_BASE)),
  ],
  ...overrides,
});

export const defineReplicaStoreTests = ({ name, factory }: ReplicaStoreTestSuiteOptions): void => {
  describe(`${name} ReplicaStore`, () => {
    it("reads null before anything is saved", async () => {
      const store = await factory();
      expect(await store.load()).toBe(null);
    });

    it("round-trips rows plus position and revision", async () => {
      const store = await factory();
      const record = buildRecord();
      await store.save(record);
      expect(await store.load()).toEqual(record);
    });

    it("round-trips an empty replica", async () => {
      const store = await factory();
      const record = buildRecord({ position: 0, revision: 0, entities: [] });
      await store.save(record);
      expect(await store.load()).toEqual(record);
    });

    it("overwrites the single slot", async () => {
      const store = await factory();
      await store.save(buildRecord());
      const next = buildRecord({
        position: 9,
        revision: 4,
        entities: [buildTodoEntity("todo_3", "Third", makeHlc(HLC_BASE))],
      });
      await store.save(next);
      expect(await store.load()).toEqual(next);
    });

    it("clears the record", async () => {
      const store = await factory();
      await store.save(buildRecord());
      await store.clear();
      expect(await store.load()).toBe(null);
    });

    it("reads an unknown format as null", async () => {
      const store = await factory();
      await store.save(buildRecord({ format: 999 }));
      expect(await store.load()).toBe(null);
    });

    it("reads a negative watermark as null", async () => {
      const store = await factory();
      await store.save(buildRecord({ position: -1 }));
      expect(await store.load()).toBe(null);
    });

    it("reads a fractional revision as null", async () => {
      const store = await factory();
      await store.save(buildRecord({ revision: 1.5 }));
      expect(await store.load()).toBe(null);
    });

    it("recovers when a valid record replaces a corrupt one", async () => {
      const store = await factory();
      await store.save(buildRecord({ format: 999 }));
      expect(await store.load()).toBe(null);

      const record = buildRecord();
      await store.save(record);
      expect(await store.load()).toEqual(record);
    });
  });
};
