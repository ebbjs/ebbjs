/**
 * Unit tests for the shared entity diff.
 *
 * The diff is the vocabulary a conflict view and a history view read: one
 * entry per position whose projected value differs between two rows.
 */

import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";
import { describe, expect, it } from "vitest";

import { diffEntity } from "./entity-diff";

const LOCAL_HLC = makeHlc(1_711_036_800_000);
const PEER_HLC = makeHlc(1_711_036_800_001);

/** A leaf field value at the local HLC unless overridden. */
const leaf = (value: unknown, updateId = "u_local", hlc = LOCAL_HLC): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

/** A map field value. */
const map = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

/** A materialized row for one subject. */
const row = (fields: Record<string, FieldValue>): Entity => ({
  id: "todo_1",
  type: "todo",
  data: { fields },
  exists: true,
  created_hlc: LOCAL_HLC,
  updated_hlc: LOCAL_HLC,
  deleted_hlc: null,
  last_gsn: 1,
});

describe("diffEntity", () => {
  it("reads a null before as every after field added", () => {
    const after = row({ title: leaf("theirs", "u_peer", PEER_HLC) });

    expect(diffEntity(null, after)).toEqual([
      { component: "todo/title", path: [], before: undefined, after: "theirs", kind: "added" },
    ]);
  });

  it("reads a field missing from the after row as removed", () => {
    const before = row({ title: leaf("mine"), notes: leaf("draft") });
    const after = row({ title: leaf("mine") });

    expect(diffEntity(before, after)).toEqual([
      { component: "todo/notes", path: [], before: "draft", after: undefined, kind: "removed" },
    ]);
  });

  it("reads a null after as every before field removed", () => {
    const before = row({ title: leaf("mine") });

    expect(diffEntity(before, null)).toEqual([
      { component: "todo/title", path: [], before: "mine", after: undefined, kind: "removed" },
    ]);
  });

  it("reads a differing leaf as changed", () => {
    const before = row({ title: leaf("mine") });
    const after = row({ title: leaf("theirs", "u_peer", PEER_HLC) });

    expect(diffEntity(before, after)).toEqual([
      { component: "todo/title", path: [], before: "mine", after: "theirs", kind: "changed" },
    ]);
  });

  it("emits one entry per differing map key, in sorted key order", () => {
    const before = row({
      content: map({ b: leaf("mine", "u_b"), a: leaf("keep", "u_a") }),
    });
    const after = row({
      content: map({
        c: leaf("new", "u_c"),
        b: leaf("theirs", "u_b"),
        a: leaf("keep", "u_a"),
      }),
    });

    expect(diffEntity(before, after)).toEqual([
      { component: "todo/content", path: ["b"], before: "mine", after: "theirs", kind: "changed" },
      { component: "todo/content", path: ["c"], before: undefined, after: "new", kind: "added" },
    ]);
  });

  it("reads a tombstoned map child as absent rather than changed", () => {
    const before = row({ content: map({ a: leaf("mine"), b: leaf("keep") }) });
    const after = row({ content: map({ a: leaf(null, "u_peer", PEER_HLC), b: leaf("keep") }) });

    expect(diffEntity(before, after)).toEqual([
      { component: "todo/content", path: ["a"], before: "mine", after: undefined, kind: "removed" },
    ]);
  });

  it("emits nothing for positions whose projected values match", () => {
    const before = row({ title: leaf("same", "u_a"), content: map({ a: leaf(1, "u_a") }) });
    const after = row({
      title: leaf("same", "u_b", PEER_HLC),
      content: map({ a: leaf(1, "u_b", PEER_HLC) }),
    });

    expect(diffEntity(before, after)).toEqual([]);
  });

  it("emits one changed entry for a map leaf kind divergence", () => {
    const before = row({ content: map({ a: leaf("mine") }) });
    const after = row({ content: leaf("whole", "u_peer", PEER_HLC) });

    expect(diffEntity(before, after)).toEqual([
      {
        component: "todo/content",
        path: [],
        before: { a: "mine" },
        after: "whole",
        kind: "changed",
      },
    ]);
  });

  it("emits top-level fields in sorted name order", () => {
    const before = row({ title: leaf("mine"), content: map({ a: leaf("mine") }) });
    const after = row({ content: map({ a: leaf("theirs") }), title: leaf("theirs") });

    expect(diffEntity(before, after).map((diff) => diff.component)).toEqual([
      "todo/content",
      "todo/title",
    ]);
  });
});
