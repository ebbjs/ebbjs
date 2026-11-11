/**
 * Wire adapter tests — cells in and out of ebb Actions.
 *
 * The body is a map field keyed by cell id with a `version` leaf written by
 * every edit. These tests cover parsing, building, the version gate, the
 * append-only rule, and delivery as re-projection.
 */

import { describe, expect, it } from "vitest";
import {
  componentName,
  format,
  pack,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import {
  appendOnlyRewrites,
  appendOnlyViolations,
  applyActions,
  assertAppendOnly,
  assertKnownVersion,
  AppendOnlyViolationError,
  buildInitialDocumentFields,
  contentFieldFromCells,
  contentKeys,
  docActionToUpdate,
  DocumentVersionError,
  isDocSubjectUpdate,
  parseContentField,
  readCellFields,
  versionField,
} from "./wire";
import { CURRENT_TEXT_VERSION, DOC_CONTENT_FIELD, DOC_VERSION_FIELD } from "./schema";
import { createDocState, makeRunId, type RunCell, type TextCell } from "./tree";

const hlc = (ts: number): HLCTimestamp => format(pack(BigInt(ts), 0n));
const T = hlc(10);

const run = (id: string, text: string, anchor = { runId: "ROOT", offset: 0 }): RunCell => ({
  kind: "run",
  id,
  text,
  author: "a",
  stamp: T,
  anchor,
});

/** One Update per field, each naming its own `<docType>/<field>` component. */
const updatesWith = (fields: Record<string, FieldValue>, docType = "text_document"): Update[] =>
  Object.entries(fields).map(([field, value]) => ({
    id: `upd_${field}`,
    subject_id: "doc_1",
    component: componentName(docType, field),
    method: "merge",
    data: value,
  }));

const actionWith = (...updates: Update[]): Action => ({
  id: "act_1",
  actor_id: "a",
  hlc: T,
  gsn: 1,
  updates,
});

const contentOf = (cellList: TextCell[]): FieldValue => ({
  map: Object.fromEntries(
    cellList.map((cell) => [cell.id, { value: cell, update_id: `u_${cell.id}`, hlc: cell.stamp }]),
  ),
});

describe("parseContentField", () => {
  it("parses current run cells", () => {
    const base = run("r1", "hello");
    const parsed = parseContentField(contentOf([base]));
    expect(parsed.get("r1")?.value).toEqual(base);
  });

  it("ignores non-map content and legacy shapes", () => {
    expect(parseContentField(undefined).size).toBe(0);
    expect(parseContentField({ value: 1, update_id: "u", hlc: T }).size).toBe(0);
    expect(
      parseContentField({
        map: {
          r1: {
            value: { id: "r1", text: "hi", parentId: "ROOT", deleted: false },
            update_id: "u",
            hlc: T,
          },
        },
      }).size,
    ).toBe(0);
  });
});

describe("contentKeys", () => {
  it("returns the map's keys and nothing for other shapes", () => {
    expect(contentKeys(contentOf([run("r1", "a"), run("r2", "b")]))).toEqual(["r1", "r2"]);
    expect(contentKeys(undefined)).toEqual([]);
    expect(contentKeys({ value: 1 })).toEqual([]);
  });
});

describe("version", () => {
  it("treats an absent version as current and rejects an unknown one", () => {
    // An empty seeded body may carry no version leaf yet.
    expect(() => assertKnownVersion(undefined)).not.toThrow();
    expect(() => assertKnownVersion(versionField(T, "u"))).not.toThrow();
    expect(() => assertKnownVersion(versionField(T, "u", CURRENT_TEXT_VERSION + 1))).toThrow(
      DocumentVersionError,
    );
    expect(() => assertKnownVersion(versionField(T, "u", "v9" as never))).toThrow(
      /not readable by this client/,
    );
  });

  it("writes one Update per component, the version leaf beside the cells", () => {
    const updates = docActionToUpdate([run("r1", "hi")], { docId: "doc_1", updateId: "u1" })!;
    const content = updates.find(
      (update) => update.method !== "delete" && update.component === "text_document/content",
    )!;
    const version = updates.find(
      (update) => update.method !== "delete" && update.component === "text_document/version",
    )!;

    expect(version.data).toMatchObject({ value: CURRENT_TEXT_VERSION });
    expect(content.data).toBeDefined();
  });
});

describe("building content", () => {
  it("wraps cells under the document's content map with their own stamps", () => {
    const base = run("r1", "hi");
    const field = contentFieldFromCells([base], "u1");
    expect(field).toEqual({ map: { r1: { value: base, update_id: "u1", hlc: base.stamp } } });
  });

  it("builds a first run at the root plus the version leaf", () => {
    const fields = buildInitialDocumentFields("hello", T, "actor_a", "u1");
    expect(fields[DOC_VERSION_FIELD]).toMatchObject({ value: CURRENT_TEXT_VERSION });
    expect(contentKeys(fields[DOC_CONTENT_FIELD])).toEqual([makeRunId(T, "actor_a")]);

    const parsed = parseContentField(
      buildInitialDocumentFields("hello", T, "actor_a", "u1")[DOC_CONTENT_FIELD]!,
    );
    const cells = [...parsed.values()];
    expect(cells[0]?.value).toMatchObject({
      kind: "run",
      text: "hello",
      author: "actor_a",
      anchor: { runId: "ROOT", offset: 0 },
    });
  });
});

describe("append-only discipline", () => {
  it("permits keys that are new", () => {
    expect(appendOnlyViolations(["a", "b"], ["c"])).toEqual([]);
    expect(() => assertAppendOnly(["a"], ["b"])).not.toThrow();
  });

  it("reports every rewritten key", () => {
    expect(appendOnlyViolations(["a", "b", "c"], ["b", "c"])).toEqual(["b", "c"]);
  });

  it("compares cells structurally, not by JSON key order", () => {
    const base = run("r1", "hello");
    const reordered = {
      anchor: { offset: base.anchor.offset, runId: base.anchor.runId },
      stamp: base.stamp,
      text: base.text,
      author: base.author,
      id: base.id,
      kind: base.kind,
    } as RunCell;
    const incoming = new Map([[base.id, { value: reordered, update_id: "u1", hlc: base.stamp }]]);
    const existing = new Map([[base.id, { value: base, update_id: "u1", hlc: base.stamp }]]);
    expect(appendOnlyRewrites(incoming, existing)).toEqual([]);
  });

  it("reports a different value under an existing key", () => {
    const base = run("r1", "hello");
    const rewritten = { ...base, text: "goodbye" };
    const incoming = new Map([[base.id, { value: rewritten, update_id: "u2", hlc: base.stamp }]]);
    const existing = new Map([[base.id, { value: base, update_id: "u1", hlc: base.stamp }]]);
    expect(appendOnlyRewrites(incoming, existing)).toEqual([base.id]);
  });

  it("throws with the existing key set", () => {
    try {
      assertAppendOnly(["a"], ["a"]);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppendOnlyViolationError);
      expect((error as AppendOnlyViolationError).keys).toEqual(["a"]);
    }
  });
});

describe("applyActions", () => {
  it("projects delivered cells and reports only newly delivered ones", () => {
    const base = run("r1", "hello");
    const updates = updatesWith({
      [DOC_CONTENT_FIELD]: contentOf([base]),
      [DOC_VERSION_FIELD]: versionField(T, "u"),
    });

    const first = applyActions(createDocState(), [actionWith(...updates)]);
    expect(first.state.text).toBe("hello");
    expect(first.applied).toEqual([{ cellId: "r1", cell: base }]);

    const again = applyActions(first.state, [actionWith(...updates)]);
    expect(again.state).toBe(first.state);
    expect(again.applied).toEqual([]);
  });

  it("identifies a document's component Update", () => {
    const doc: Update = {
      id: "u_doc",
      subject_id: "doc_1",
      component: "text_document/content",
      method: "drop",
      data: null,
    };
    const other: Update = {
      id: "u_other",
      subject_id: "doc_1",
      component: "other/content",
      method: "drop",
      data: null,
    };
    expect(isDocSubjectUpdate(doc, "text_document")).toBe(true);
    expect(isDocSubjectUpdate(other, "text_document")).toBe(false);
  });

  it("reads cells out of an Update", () => {
    const [update] = updatesWith({ [DOC_CONTENT_FIELD]: contentOf([run("r1", "hi")]) });
    expect([...readCellFields(update!).keys()]).toEqual(["r1"]);
  });
});
