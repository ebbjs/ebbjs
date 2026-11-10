import { describe, expect, it } from "vitest";
import { makeHlc, type Entity, type FieldValue } from "@ebbjs/core";

import {
  applyComponentDelta,
  buildComponentIndex,
  componentDelta,
  componentIds,
  componentsOf,
  touchedComponents,
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

describe("touchedComponents", () => {
  it("touches nothing when neither side differs", () => {
    const before = row("e_1", "todo", { title: leaf("a") });
    expect(touchedComponents(undefined, undefined)).toEqual([]);
    expect(touchedComponents(null, null)).toEqual([]);
    expect(touchedComponents(before, before)).toEqual([]);
  });

  it("touches every component the row carries when a row arrives or leaves", () => {
    const attached = row("e_1", "todo", { title: leaf("a"), status: leaf("open") });
    expect(touchedComponents(null, attached)).toEqual(["todo/title", "todo/status"]);
    expect(touchedComponents(attached, null)).toEqual(["todo/title", "todo/status"]);
  });

  it("touches only the component whose value changed", () => {
    const status = leaf("open");
    const body = leaf("b");
    const before = row("e_1", "note", { title: leaf("a"), status, body });
    const after = row("e_1", "note", { title: leaf("a2"), status, body });
    expect(touchedComponents(before, after)).toEqual(["note/title"]);
  });

  it("touches a component on either side of an attach or a drop", () => {
    const title = leaf("a");
    const before = row("e_1", "note", { title, draft: leaf("d") });
    const after = row("e_1", "note", { title });
    expect(touchedComponents(before, after)).toEqual(["note/draft"]);
    expect(touchedComponents(after, before)).toEqual(["note/draft"]);
  });

  it("touches every component on a tombstone transition", () => {
    const live = row("e_1", "note", { title: leaf("a"), status: leaf("open") });
    const dead = { ...live, deleted_hlc: makeHlc(2) };
    expect(touchedComponents(live, dead)).toEqual(["note/title", "note/status"]);
    expect(touchedComponents(dead, live)).toEqual(["note/title", "note/status"]);
  });

  it("touches every component on either side of a model change", () => {
    const before = row("e_1", "note", { title: leaf("a") });
    const after = row("e_1", "page", { title: leaf("a") });
    expect(touchedComponents(before, after)).toEqual(["note/title", "page/title"]);
  });

  it("reads a freshly built value as a touch even when it is structurally equal", () => {
    const before = row("e_1", "note", { title: leaf("a") });
    const after = row("e_1", "note", { title: leaf("a") });
    expect(touchedComponents(before, after)).toEqual(["note/title"]);
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
