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
  isComponentUpdate,
  pack,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import {
  appendOnlyViolations,
  applyActions,
  assertAppendOnly,
  assertKnownVersion,
  AppendOnlyViolationError,
  buildInitialDocumentFields,
  contentFieldFromCells,
  docActionToUpdate,
  DocumentVersionError,
  isDocModelUpdate,
  parseContentField,
  versionField,
} from "./wire";
import { CURRENT_TEXT_VERSION, DOC_CONTENT_FIELD, DOC_VERSION_FIELD } from "./schema";
import { createDocState, type RunCell, type TextCell } from "./tree";

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

/** One Update per field, each naming its own `<docModel>/<field>` component. */
const updatesWith = (fields: Record<string, FieldValue>, docModel = "text_document"): Update[] =>
  Object.entries(fields).map(([field, value]) => ({
    id: `upd_${field}`,
    subject_id: "doc_1",
    component: componentName(docModel, field),
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
      (update) => isComponentUpdate(update) && update.component === "text_document/content",
    )!;
    const version = updates.find(
      (update) => isComponentUpdate(update) && update.component === "text_document/version",
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
    expect(() => assertAppendOnly("text_document/content", ["a"], ["b"])).not.toThrow();
  });

  it("reports every rewritten key", () => {
    expect(appendOnlyViolations(["a", "b", "c"], ["b", "c"])).toEqual(["b", "c"]);
  });

  it("throws with the component and the existing key set", () => {
    try {
      assertAppendOnly("text_document/content", ["a"], ["a"]);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppendOnlyViolationError);
      expect((error as AppendOnlyViolationError).component).toBe("text_document/content");
      expect((error as AppendOnlyViolationError).keys).toEqual(["a"]);
      expect((error as Error).message).toContain("text_document/content");
      expect((error as Error).message).toContain("may only be added");
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
    expect(isDocModelUpdate(doc, "text_document")).toBe(true);
    expect(isDocModelUpdate(other, "text_document")).toBe(false);
  });
});
