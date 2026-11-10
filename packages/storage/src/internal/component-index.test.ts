import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";

import {
  applyComponentDelta,
  buildComponentIndex,
  componentDelta,
  componentIds,
  componentsOf,
} from "./component-index";

const leaf = (value: unknown): FieldValue => ({ value, update_id: "u", hlc: makeHlc(1) });

const row = (id: string, type: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  type,
  data: { fields },
  exists: true,
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

describe("componentsOf", () => {
  it("names one component per present field", () => {
    expect(componentsOf(row("e_1", "todo", { title: leaf("a"), status: leaf("b") }))).toEqual([
      "todo/title",
      "todo/status",
    ]);
  });

  it("names none for a row with nothing attached", () => {
    expect(componentsOf(row("e_1", "todo", {}))).toEqual([]);
  });
});

describe("componentDelta", () => {
  it("has no delta when neither side exists", () => {
    expect(componentDelta(undefined, undefined)).toBeNull();
  });

  it("adds a first row and removes a deleted one", () => {
    const before = row("e_1", "todo", { title: leaf("a") });
    expect(componentDelta(undefined, before)).toEqual({
      rowId: "e_1",
      remove: [],
      add: ["todo/title"],
    });
    expect(componentDelta(before, undefined)).toEqual({
      rowId: "e_1",
      remove: ["todo/title"],
      add: [],
    });
  });

  it("adds and removes only the fields that changed", () => {
    const before = row("e_1", "todo", { title: leaf("a"), status: leaf("open") });
    const after = row("e_1", "todo", { title: leaf("b"), draft: leaf("c") });
    expect(componentDelta(before, after)).toEqual({
      rowId: "e_1",
      remove: ["todo/status"],
      add: ["todo/draft"],
    });
  });
});

describe("applyComponentDelta", () => {
  it("returns a new index and drops an emptied component", () => {
    const before = row("e_1", "todo", { title: leaf("a") });
    const index = applyComponentDelta(new Map(), componentDelta(undefined, before)!);
    expect(componentIds(index, "todo/title")).toEqual(["e_1"]);

    const next = applyComponentDelta(index, componentDelta(before, undefined)!);
    expect(next).not.toBe(index);
    expect(componentIds(next, "todo/title")).toEqual([]);
    expect(componentIds(index, "todo/title")).toEqual(["e_1"]);
  });
});

describe("buildComponentIndex", () => {
  it("keeps ids per component in ascending order", () => {
    const index = buildComponentIndex([
      row("e_2", "todo", { title: leaf("b") }),
      row("e_1", "todo", { title: leaf("a") }),
      row("e_3", "todo", {}),
    ]);
    expect(componentIds(index, "todo/title")).toEqual(["e_1", "e_2"]);
  });
});
