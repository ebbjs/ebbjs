import { describe, expect, it } from "vitest";
import { makeHlc } from "@ebbjs/core";

import type { OutboxEntry, OutboxStatus, OutboxStore } from "../types/outbox-store";
import { buildPutAction } from "./fixtures";

export interface OutboxStoreTestSuiteHarness {
  store: OutboxStore;
  /**
   * Reopen the same backing storage. Provided only by backends that
   * persist across an adapter reopen; the in-memory store cannot
   * outlive the adapter that owns it.
   */
  reopen?: () => Promise<OutboxStore>;
}

export interface OutboxStoreTestSuiteOptions {
  name: string;
  factory: () => Promise<OutboxStoreTestSuiteHarness> | OutboxStoreTestSuiteHarness;
}

/**
 * The buffered Action's identity is the only thing the store keys on;
 * its Updates are irrelevant to these tests.
 */
const mkEntry = (
  id: string,
  enqueuedAtMs: number,
  status: OutboxStatus = "pending",
): OutboxEntry => ({
  action: { ...buildPutAction(), id },
  status,
  enqueuedAtHlc: makeHlc(enqueuedAtMs),
});

export const defineOutboxStoreTests = ({ name, factory }: OutboxStoreTestSuiteOptions): void => {
  describe(`${name} OutboxStore`, () => {
    describe("get", () => {
      it("returns null for an unknown action id", async () => {
        const { store } = await factory();
        expect(await store.get("a_missing")).toBe(null);
      });

      it("returns a stored entry by action id", async () => {
        const { store } = await factory();
        const entry = mkEntry("a_1", 1);
        await store.put(entry);

        expect(await store.get("a_1")).toEqual(entry);
      });
    });

    describe("put", () => {
      it("replaces an existing entry for the same action id", async () => {
        const { store } = await factory();
        await store.put(mkEntry("a_1", 1, "pending"));

        await store.put(mkEntry("a_1", 1, "acknowledged"));

        expect(await store.get("a_1")).toEqual(mkEntry("a_1", 1, "acknowledged"));
        expect(await store.list()).toHaveLength(1);
      });
    });

    describe("list", () => {
      it("returns an empty list when nothing was put", async () => {
        const { store } = await factory();
        expect(await store.list()).toEqual([]);
      });

      it("orders entries by enqueuedAtHlc ascending, not insertion order", async () => {
        const { store } = await factory();
        // HLCs are packed BigInts rendered as decimal strings, so the
        // larger value can be the shorter string ("1048576" sorts
        // before "65536" lexicographically). Inserting out of order
        // with a digit-length change pins numeric ordering.
        await store.put(mkEntry("a_16", 16));
        await store.put(mkEntry("a_1", 1));
        await store.put(mkEntry("a_8", 8));

        const ids = (await store.list()).map((entry) => entry.action.id);
        expect(ids).toEqual(["a_1", "a_8", "a_16"]);
      });

      it("keeps a transitioned entry in its original position", async () => {
        const { store } = await factory();
        await store.put(mkEntry("a_1", 1, "pending"));
        await store.put(mkEntry("a_2", 2, "pending"));

        await store.put(mkEntry("a_1", 1, "error"));

        const entries = await store.list();
        expect(entries.map((entry) => entry.action.id)).toEqual(["a_1", "a_2"]);
        expect(entries[0]?.status).toBe("error");
      });
    });

    describe("delete", () => {
      it("removes the entry for an action id", async () => {
        const { store } = await factory();
        await store.put(mkEntry("a_1", 1));
        await store.put(mkEntry("a_2", 2));

        await store.delete("a_1");

        expect(await store.get("a_1")).toBe(null);
        expect((await store.list()).map((entry) => entry.action.id)).toEqual(["a_2"]);
      });

      it("is a no-op for an unknown action id", async () => {
        const { store } = await factory();
        await store.put(mkEntry("a_1", 1));

        await store.delete("a_missing");

        expect((await store.list()).map((entry) => entry.action.id)).toEqual(["a_1"]);
      });
    });

    describe("clear", () => {
      it("removes every entry", async () => {
        const { store } = await factory();
        await store.put(mkEntry("a_1", 1));
        await store.put(mkEntry("a_2", 2));

        await store.clear();

        expect(await store.list()).toEqual([]);
        expect(await store.get("a_1")).toBe(null);
      });
    });

    describe("persistence", () => {
      it("keeps entries across a backing-store reopen", async (ctx) => {
        const { store, reopen } = await factory();
        ctx.skip(reopen === undefined, "backend does not persist across a reopen");
        if (reopen === undefined) return;

        await store.put(mkEntry("a_1", 1));
        await store.put(mkEntry("a_2", 2, "acknowledged"));

        const reopened = await reopen();

        expect(await reopened.get("a_1")).toEqual(mkEntry("a_1", 1));
        expect(await reopened.get("a_2")).toEqual(mkEntry("a_2", 2, "acknowledged"));
        expect((await reopened.list()).map((entry) => entry.action.id)).toEqual(["a_1", "a_2"]);
      });
    });
  });
};
