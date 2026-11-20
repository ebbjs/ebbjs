/**
 * SPIKE S4 (#779): what one selected-component declaration changes.
 *
 * Not for merge.
 */

import { describe, expect, it } from "vitest";
import type { ReplicaChange } from "@ebbjs/storage/replica";

import { emptyQuery, type Query } from "../query";
import { compileReadComponents } from "../query-plan";
import { depsOf, matchesDependencies } from "./dispatch";
import {
  compileSelection,
  select,
  selectedQueryKey,
  selectionProjection,
  selectionReadComponents,
  selectionSavings,
  structuralReads,
  todayReadComponents,
} from "./select";

const noteQuery = (groups: Query["groups"] = [], joins: Query["joins"] = []): Query => ({
  ...emptyQuery("note"),
  groups,
  joins,
});

const change = (id: string, components: readonly string[]): ReplicaChange => ({
  revision: 1,
  id,
  deleted: false,
  components,
});

describe("S4: one selection, three derivations", () => {
  it("replaces the whole-model read for a rows result", () => {
    const query = noteQuery();
    const selected = select(query, ["note/title", "note/status"]);

    expect(todayReadComponents(query)).toEqual(["note/*", "ebb/membership"]);
    expect(selectionReadComponents(selected)).toEqual([
      "note/title",
      "note/status",
      "ebb/membership",
    ]);
    expect(
      selectionSavings(selected, ["note/title", "note/status", "note/content", "note/engine"]),
    ).toEqual({
      today: 5,
      selected: 3,
    });
  });

  it("keeps predicate and ordering reads even when the field is not projected", () => {
    const query = noteQuery([[{ kind: "field", field: "status", value: "open" }]]);
    const selected = select(query, ["note/title"]);
    expect(selectionReadComponents(selected)).toEqual([
      "note/title",
      "note/status",
      "ebb/membership",
    ]);
    // The projection is narrower than the lease set: `status` is read, not
    // returned.
    expect(selectionProjection(selected.selected ?? [])).toEqual(["title"]);
  });

  it("invalidates on a selected component but not on an unselected one", () => {
    const today = depsOf(compileReadComponents(todayReadComponents(noteQuery())));
    const selected = depsOf(compileSelection(select(noteQuery(), ["note/title"])));

    expect(matchesDependencies(today, change("n_1", ["note/content"]))).toBe(true);
    expect(matchesDependencies(selected, change("n_1", ["note/content"]))).toBe(false);
    expect(matchesDependencies(selected, change("n_1", ["note/title"]))).toBe(true);
  });

  it("cannot hear a row enter or leave the source set on its own", () => {
    // A bare create/delete names no component. Today's whole-model read treats
    // that as a hit; a selection of value components does not. The membership
    // dependency is separate, which is why `structuralReads` exists.
    const selected = depsOf(compileSelection(select(noteQuery(), ["note/title"])));
    expect(matchesDependencies(selected, change("n_1", []))).toBe(false);
    expect(structuralReads(select(noteQuery(), ["note/title"]))).toEqual({
      rows: ["note"],
      indices: [],
    });
  });

  it("gives two selections of the same query distinct cache keys", () => {
    const query = select(noteQuery(), ["note/title"]);
    const other = select(noteQuery(), ["note/title", "note/content"]);
    expect(selectedQueryKey(query)).not.toEqual(selectedQueryKey(other));
    expect(selectedQueryKey(query)).toEqual(selectedQueryKey(select(noteQuery(), ["note/title"])));
  });

  it("names the indices a filtered or joined query reads", () => {
    const query = select(
      noteQuery(
        [
          [{ kind: "membership", anyOf: ["g_1"] }],
          [{ kind: "field", field: "status", value: "open" }],
        ],
        [
          {
            kind: "relationship",
            as: "author",
            type: "wrote",
            target: "person",
            direction: "forward",
            cardinality: "one",
          },
        ],
      ),
      ["note/title"],
    );
    expect(structuralReads(query)).toEqual({
      rows: ["note"],
      indices: ["membership", "relation:author/wrote"],
    });
  });
});
