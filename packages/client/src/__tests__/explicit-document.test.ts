/**
 * A text body as an explicitly declared document entity.
 *
 * The app declares the parent, the document, and the one-cardinality link
 * between them. A create is an ordinary Action over those declarations — no
 * generated entity, id, relationship, or accessor sits behind it.
 */

import { describe, expect, it } from "vitest";
import {
  decodeSync,
  isFieldMap,
  makeHlc,
  type Action,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import {
  AppendOnlyViolationError,
  CURRENT_TEXT_VERSION,
  e,
  defineModel,
  defineRelationship,
  defineSchema,
  makeRunId,
  ROOT_ANCHOR,
  TextCellSchema,
  type TextCell,
} from "@ebbjs/schema";
import { defineAction } from "../schema/action";
import { createClient } from "../sync/client";
import { callApplyAction, jsonResponse, updateModel, waitFor } from "../sync/test-utils";

const note = defineModel("note", { title: e.string() });
const textDocument = defineModel(
  "text_document",
  { content: e.map(TextCellSchema), version: e.number() },
  { materialization: "on-demand" },
);
const noteBody = defineRelationship({
  source: note,
  target: textDocument,
  as: "body",
  sourceCardinality: "one",
});
const schema = defineSchema({
  models: { note, text_document: textDocument },
  relationships: { noteBody },
  version: 1,
});

const stamp = makeHlc(1_711_036_800_000);
const initialRun: TextCell = {
  kind: "run",
  id: makeRunId(stamp, "actor_1"),
  text: "Hello world",
  author: "actor_1",
  stamp,
  anchor: ROOT_ANCHOR,
};
const initialContent = { [initialRun.id]: initialRun };

const createNote = defineAction(schema, ({ note, text_document }) => {
  const createdNote = note.create({ title: "Greeting" }, { groups: ["g_1"] });
  const createdDocument = text_document.create(
    { content: initialContent, version: CURRENT_TEXT_VERSION },
    { groups: ["g_1"] },
  );
  note.link(createdNote.id, "body", createdDocument.id);
  return { noteId: createdNote.id, documentId: createdDocument.id };
});

const HANDSHAKE = {
  actor_id: "actor_1",
  groups: ["g_1"].map((id) => ({
    id,
    permissions: ["note.*", "text_document.*", "relationship.*", "entityGroup.*"],
    cursor_valid: true,
    reason: null,
    cursor: 0,
  })),
};

function harness() {
  const storage = createMemoryAdapter();
  const written: Action[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/sync/handshake")) return jsonResponse(HANDSHAKE);
    if (url.endsWith("/sync/actions")) {
      if (init?.body instanceof Uint8Array) {
        written.push(...decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
  const client = createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage,
    schema,
    actions: { createNote },
    fetchImpl,
  });
  return { client, written };
}

/** One entry of a cell map field on the wire. */
interface CellEntry {
  readonly value: TextCell;
  readonly update_id: string;
  readonly hlc: string;
}

/** A cell patch: the wire shape an edit to a map field takes. */
const cellPatch = (
  docId: string,
  cells: Record<string, CellEntry>,
  updateId: string,
  hlc: string,
): Action => ({
  id: `act_${updateId}`,
  actor_id: "actor_1",
  hlc,
  gsn: 0,
  updates: [
    {
      id: `${updateId}_0`,
      subject_id: docId,
      component: "text_document/content",
      method: "merge",
      data: { map: cells },
    },
    {
      id: `${updateId}_1`,
      subject_id: docId,
      component: "text_document/version",
      method: "merge",
      data: { value: CURRENT_TEXT_VERSION, update_id: updateId, hlc },
    },
  ],
});

/** The Updates of one model, grouped into one list per subject row. */
const rowsOf = (updates: readonly Update[], model: string): readonly (readonly Update[])[] => {
  const bySubject = new Map<string, Update[]>();
  for (const update of updates) {
    if (updateModel(update) !== model) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/** One component's value on a row, or a failure naming the field. */
const componentOf = (row: readonly Update[], field: string): FieldValue => {
  const update = row.find(
    (candidate) =>
      candidate.method !== "drop" &&
      candidate.method !== "delete" &&
      candidate.component === `text_document/${field}`,
  );
  if (update === undefined || update.method === "drop" || update.method === "delete") {
    throw new Error(`row carries no "${field}" component`);
  }
  return update.data;
};

/** The cell map a row's content component carries. */
const cellsOf = (row: readonly Update[]): Record<string, CellEntry> => {
  const content = componentOf(row, "content");
  if (!isFieldMap(content)) throw new Error("document content is not a map field");
  return content.map as unknown as Record<string, CellEntry>;
};

describe("a document the app declares", () => {
  it("lands the note, its document, and their link in one Action", async () => {
    const { client, written } = harness();
    await client.handshake();

    const created = await client.actions.createNote();

    expect(written).toHaveLength(1);
    const updates = written[0]!.updates;

    // The membership and the link are `ebb` rows; their components name them.
    expect([...new Set(updates.map((update) => updateModel(update)))].sort()).toEqual([
      "ebb",
      "note",
      "text_document",
    ]);

    const [documentRow] = rowsOf(updates, "text_document");
    expect(documentRow![0]!.subject_id).toBe(created.documentId);
    const content = componentOf(documentRow!, "content");
    if (!isFieldMap(content)) throw new Error("document content is not a map field");
    expect(Object.keys(content.map)).toEqual([initialRun.id]);
    expect(content.map[initialRun.id]!.value).toEqual(initialRun);
    expect(componentOf(documentRow!, "version").value).toBe(CURRENT_TEXT_VERSION);

    // The link is one atomic value: one Update carries the whole edge.
    const [linkUpdate] = updates.filter(
      (update) => update.method !== "delete" && update.component === "ebb/link",
    );
    expect(
      (linkUpdate!.data as { value: { source_id: string; target_id: string } }).value,
    ).toMatchObject({ source_id: created.noteId, target_id: created.documentId });

    const row = await client.note.get(created.noteId);
    expect(row!.title).toBe("Greeting");
    expect((await row!.body)!.id).toBe(created.documentId);
  });

  it("reads the declared document row through a TextDocument", async () => {
    const { client } = harness();
    await client.handshake();

    const created = await client.actions.createNote();

    const row = await client.readLocalEntity(created.documentId);
    expect(row!.type).toBe("text_document");

    const document = client.textDocument(created.documentId, "text_document");
    document.hydrate(row!.data.fields["content"], row!.data.fields["version"]);

    expect(document.text).toBe("Hello world");
  });

  it("self-flushes an edit made through the document opener", async () => {
    const { client, written } = harness();
    await client.handshake();

    const created = await client.actions.createNote();
    const document = client.openDerivedTextDocument(created.documentId, "text_document");
    const row = await client.readLocalEntity(created.documentId);
    document.hydrate(row!.data.fields["content"], row!.data.fields["version"]);

    const before = written.length;
    document.localInsert("!");
    await waitFor(() => document.pendingActions().length === 0);

    expect(document.text).toBe("Hello world!");
    expect(written).toHaveLength(before + 1);
    const [editRow] = rowsOf(written[before]!.updates, "text_document");
    const [[, appended]] = Object.entries(cellsOf(editRow!));
    expect(appended!.value).toMatchObject({ kind: "run", text: "!" });
  });

  it("refuses to rewrite a cell already committed to the document", async () => {
    const { client, written } = harness();
    await client.handshake();

    const created = await client.actions.createNote();
    await callApplyAction(client, written[0]!, "g_1");

    const [documentRow] = rowsOf(written[0]!.updates, "text_document");
    const content = cellsOf(documentRow!);
    const [cellId, entry] = Object.entries(content)[0]!;
    const rewriteHlc = (BigInt(entry.hlc) + 1_000n).toString();

    const rewrite = cellPatch(
      created.documentId,
      {
        [cellId]: {
          ...entry,
          value: { ...initialRun, text: "rewritten" },
          update_id: "u_rewrite",
          hlc: rewriteHlc,
        },
      },
      "u_rewrite",
      rewriteHlc,
    );

    const submittedBefore = written.length;
    await expect(client.write([rewrite])).rejects.toBeInstanceOf(AppendOnlyViolationError);
    expect(written).toHaveLength(submittedBefore);

    const addedHlc = (BigInt(rewriteHlc) + 1_000n).toString();
    const addedId = `${addedHlc}:actor_1`;
    const added = cellPatch(
      created.documentId,
      {
        [addedId]: {
          value: {
            kind: "run",
            id: addedId,
            text: "!",
            author: "actor_1",
            stamp: addedHlc,
            anchor: { runId: cellId, offset: initialRun.text.length },
          },
          update_id: "u_add",
          hlc: addedHlc,
        },
      },
      "u_add",
      addedHlc,
    );

    await expect(client.write([added])).resolves.toEqual({ rejected: [] });
    expect(written.length).toBeGreaterThan(submittedBefore);
  });
});
