/**
 * `e.log` and the generic append-only helpers.
 *
 * A log is a keyed component whose entries may only be added. The marker is
 * what the write path reads; the helpers here unwrap and compare entries
 * without knowing what an entry is.
 */

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { FieldValue } from "@ebbjs/core";

import {
  ModelRegistry,
  NestedLogError,
  NestedMapError,
  defineComponent,
  defineModel,
  e,
  isLogSchema,
  logEntriesOf,
  logRewrites,
} from "./index";

const leaf = (value: unknown, updateId = "u_1"): FieldValue => ({
  value,
  update_id: updateId,
});

const mapOf = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

describe("e.log", () => {
  it("marks a bare field as a keyed log", () => {
    const doc = defineModel("doc", { content: e.log(e.string()) });

    expect(doc.markers.content).toEqual({ type: "lww", map: true, log: true });
  });

  it("carries the log marker on a named component with its own policy", () => {
    const updates = defineComponent("note/updates", e.log(e.number()), { loading: "lazy" });

    expect(updates.marker).toEqual({ type: "lww", map: true, log: true });
    expect(updates.loading).toBe("lazy");
  });

  it("validates like an ordinary keyed component", () => {
    const entries = e.log(e.number());

    expect(Value.Check(entries, { a: 1, b: 2 })).toBe(true);
    expect(Value.Check(entries, { a: "x" })).toBe(false);
  });

  it("identifies itself through isLogSchema, unlike e.map", () => {
    expect(isLogSchema(e.log(e.number()))).toBe(true);
    expect(isLogSchema(e.map(e.number()))).toBe(false);
  });

  it("does not mark a plain e.map as a log", () => {
    const doc = defineModel("doc", { cells: e.map(e.string()) });

    expect(doc.markers.cells).toEqual({ type: "lww", map: true });
  });

  it("takes a map-shaped default", () => {
    const log = e.log(e.number()).default({ a: 1 });

    expect((log as { default?: unknown }).default).toEqual({ a: 1 });
  });
});

describe("ModelRegistry.isLogField", () => {
  const doc = defineModel("doc", {
    title: e.string(),
    content: e.log(e.string()),
  });
  const registry = (): ModelRegistry => {
    const models = new ModelRegistry();
    models.register(doc);
    return models;
  };

  it("answers for a field key and for a full component name", () => {
    expect(registry().isLogField("doc", "content")).toBe(true);
    expect(registry().isLogField("doc", "doc/content")).toBe(true);
  });

  it("answers the same way for a named component with its own policy", () => {
    const note = defineModel("note", {
      title: e.string(),
      updates: defineComponent("note/updates", e.log(e.string()), { loading: "lazy" }),
    });
    const models = new ModelRegistry();
    models.register(note);

    expect(models.isLogField("note", "updates")).toBe(true);
    expect(models.isLogField("note", "note/updates")).toBe(true);
    expect(models.isLogField("note", "title")).toBe(false);
  });

  it("is false for a plain map, an unknown component, and an unknown model", () => {
    const models = registry();
    models.register(defineModel("page", { cells: e.map(e.string()) }));

    expect(models.isLogField("page", "cells")).toBe(false);
    expect(models.isLogField("page", "page/cells")).toBe(false);
    expect(models.isLogField("doc", "title")).toBe(false);
    expect(models.isLogField("doc", "missing")).toBe(false);
    expect(models.isLogField("missing", "content")).toBe(false);
    expect(new ModelRegistry().isLogField("doc", "content")).toBe(false);
  });
});

describe("log shape guard", () => {
  it("refuses a log nested inside an e.object", () => {
    expect(() => e.object({ inner: e.log(e.number()) })).toThrow(NestedMapError);
  });

  it("refuses a field-map component that declares a log", () => {
    let caught: unknown;
    try {
      defineComponent("note/body", { engine: e.string(), updates: e.log(e.string()) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NestedLogError);
    expect((caught as NestedLogError).componentName).toBe("note/body");
    expect((caught as NestedLogError).path).toBe("updates");
    expect((caught as Error).message).toContain("note/body");
    expect((caught as Error).message).toContain("own component");
  });

  it("still accepts a field-map component that declares a plain map", () => {
    const body = defineComponent("note/body", { engine: e.string(), updates: e.map(e.string()) });

    expect(body.name).toBe("note/body");
    expect(body.marker).toEqual({ type: "lww" });
  });

  it("accepts a log that is the component's own shape", () => {
    expect(defineComponent("note/updates", e.log(e.string())).marker.log).toBe(true);
  });
});

describe("logEntriesOf", () => {
  it("unwraps a map's leaf entries by key", () => {
    const entries = logEntriesOf(mapOf({ a: leaf("first"), b: leaf("second") }));

    expect([...entries]).toEqual([
      ["a", "first"],
      ["b", "second"],
    ]);
  });

  it("skips nested maps, tombstones, and a value that is not a map", () => {
    const entries = logEntriesOf(
      mapOf({
        live: leaf("kept"),
        gone: leaf(null),
        nested: mapOf({ deeper: leaf("skipped") }),
      }),
    );

    expect([...entries.keys()]).toEqual(["live"]);
    expect(logEntriesOf(undefined).size).toBe(0);
    expect(logEntriesOf(leaf("not a map")).size).toBe(0);
  });
});

describe("logRewrites", () => {
  const existing = logEntriesOf(
    mapOf({
      a: leaf({ text: "hello", anchor: { runId: "r0", offset: 0 } }, "u_1"),
      b: leaf("second", "u_1"),
    }),
  );

  it("allows an identical entry whatever its envelope", () => {
    const incoming = logEntriesOf(
      mapOf({
        a: leaf({ text: "hello", anchor: { runId: "r0", offset: 0 } }, "u_2"),
        b: leaf("second", "u_9"),
      }),
    );

    expect(logRewrites(incoming, existing)).toEqual([]);
  });

  it("compares entry values structurally, not by key order", () => {
    const incoming = logEntriesOf(
      mapOf({
        a: leaf({ anchor: { offset: 0, runId: "r0" }, text: "hello" }, "u_2"),
      }),
    );

    expect(logRewrites(incoming, existing)).toEqual([]);
  });

  it("reports a changed value under an existing key", () => {
    const incoming = logEntriesOf(mapOf({ b: leaf("rewritten", "u_2") }));

    expect(logRewrites(incoming, existing)).toEqual(["b"]);
  });

  it("reports nothing for a key the log does not hold yet", () => {
    expect(logRewrites(logEntriesOf(mapOf({ c: leaf("new") })), existing)).toEqual([]);
    expect(logRewrites(new Map(), existing)).toEqual([]);
  });
});
