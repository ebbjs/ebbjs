/**
 * SPIKE S1 (#779): characterise the capacity-truncation bug.
 *
 * The replica trims its pin window (`pinnedCapacity`, renamed
 * `cacheCapacity` in #932) after every open. A caller that opens more
 * components on one row than the window holds gets back a row that is
 * silently missing components: no error, no `unloaded`, no journal entry
 * that distinguishes it from a component the row never carried.
 *
 * Not for merge. Evidence for docs/research/779-subscription-residency.md.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";

import { REPLICA_RECORD_FORMAT } from "../../internal/replica-record";
import type { ReplicaRecord } from "../../types/replica-store";
import { createReplica } from "../replica";

const leaf = (value: unknown): FieldValue => ({
  value,
  update_id: `u_${String(value)}`,
  hlc: makeHlc(1),
});

/** A row carrying three components: metadata, engine, and a body log. */
const threeComponentRow = (id: string): Entity => ({
  id,
  model: "note",
  data: {
    fields: {
      title: leaf(`title ${id}`),
      engine: leaf({ kind: "prosemirror" }),
      content: leaf(`body ${id}`),
    },
  },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

const recordOf = (rows: readonly Entity[]): ReplicaRecord => ({
  format: REPLICA_RECORD_FORMAT,
  position: 1,
  revision: 1,
  entities: rows,
  componentVersions: Object.fromEntries(
    rows.map((row) => [row.id, { "note/title": 1, "note/engine": 1, "note/content": 1 }]),
  ),
});

/** Every component of the note is materialized on demand. */
const lazyBody = {
  holds: (_component: string): boolean => false,
};

describe("S1: pin-window truncation is silent data loss on a read", () => {
  it("drops the first of three components requested on one row, with no error", async () => {
    const stored = threeComponentRow("n_1");
    const replica = createReplica({
      materialization: lazyBody,
      pinnedCapacity: 2,
      // Keep the released component's pin from lingering: the TTL does not
      // matter here, the capacity trim already moved it.
      pinnedTtlMs: 60_000,
      readComponent: async (id) => (id === stored.id ? stored : null),
    });
    replica.load(recordOf([stored]));
    expect(replica.isRowHeld(stored)).toBe(false);
    const floor = replica.revision;

    // What `client.note.get(id)` does today: open every non-held component the
    // stored row carries, in field order, then project the composed row.
    const requested = ["note/title", "note/engine", "note/content"];
    for (const component of requested) {
      if (!replica.isHeld(component)) await replica.open(stored.id, component);
    }

    const row = replica.get(stored.id);
    expect(row).toBeDefined();
    const carried = Object.keys(row?.data.fields ?? {});
    // EVIDENCE: the read succeeded, reported the row, and lost `title` —
    // the first component asked for, evicted by the later open.
    expect(carried).toEqual(["engine", "content"]);
    expect(replica.isOpen(stored.id, "note/title")).toBe(false);
    expect(replica.isComponentResident(stored.id, "note/title")).toBe(false);

    // Nothing in the journal says "engine was truncated": the only entry is
    // the install, followed by a release entry that reads exactly like a
    // deliberate close. A subscriber sees only that the component left.
    const changes = replica.changesSince(floor);
    console.log("S1 journal:", JSON.stringify(changes));
    expect(changes.some((change) => change.components.includes("note/title"))).toBe(true);
    expect(replica.stats().pinnedComponents).toEqual({ "note/content": 1, "note/engine": 1 });
    console.log("S1 row fields:", JSON.stringify(carried));
  });

  it("one row's read evicts an unrelated row's open component", async () => {
    const rows = {
      n_1: threeComponentRow("n_1"),
      n_2: threeComponentRow("n_2"),
    };
    const replica = createReplica({
      materialization: lazyBody,
      pinnedCapacity: 2,
      pinnedTtlMs: 60_000,
      readComponent: async (id) => rows[id as keyof typeof rows] ?? null,
    });
    replica.load(recordOf(Object.values(rows)));

    await replica.open("n_1", "note/content");
    await replica.open("n_2", "note/content");
    // Opening n_2's engine overflows the window and evicts n_1's body, a row
    // the caller is not touching.
    await replica.open("n_2", "note/engine");

    expect(replica.isOpen("n_1", "note/content")).toBe(false);
    expect(replica.get("n_1")).toBeUndefined();
    console.log("S1 unrelated-row stats:", JSON.stringify(replica.stats().pinnedComponents));
  });

  it("an unbounded window returns the full selection", async () => {
    const stored = threeComponentRow("n_1");
    const replica = createReplica({
      materialization: lazyBody,
      pinnedCapacity: 0,
      readComponent: async () => stored,
    });
    replica.load(recordOf([stored]));
    for (const component of ["note/title", "note/engine", "note/content"]) {
      await replica.open(stored.id, component);
    }
    expect(Object.keys(replica.get(stored.id)?.data.fields ?? {})).toEqual([
      "title",
      "engine",
      "content",
    ]);
  });
});
