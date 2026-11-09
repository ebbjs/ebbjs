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
  CURRENT_TEXT_VERSION,
  e,
  defineEntity,
  defineRelationship,
  defineSchema,
  makeRunId,
  ROOT_ANCHOR,
  TextCellSchema,
  type TextCell,
} from "@ebbjs/schema";
import { defineAction } from "../schema/action";
import { createClient } from "../sync/client";
import { jsonResponse } from "../sync/test-utils";

const note = defineEntity("note", { title: e.string() });
const textDocument = defineEntity(
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
  entities: { note, text_document: textDocument },
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

const waitForFlush = async (pending: () => readonly Action[]): Promise<void> => {
  for (let i = 0; i < 50 && pending().length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const fieldsOf = (update: Update): Record<string, FieldValue> => {
  if (update.data === null || update.data === undefined) {
    throw new Error(`update "${update.id}" carries no fields`);
  }
  return update.data.fields;
};

describe("a document the app declares", () => {
  it("lands the note, its document, and their link in one Action", async () => {
    const { client, written } = harness();
    await client.handshake();

    const created = await client.actions.createNote();

    expect(written).toHaveLength(1);
    const updates = written[0]!.updates;

    const declaredTypes = new Set([...Object.keys(schema.entities), "relationship", "entityGroup"]);
    expect([...new Set(updates.map((update) => update.subject_type))].sort()).toEqual([
      "entityGroup",
      "note",
      "relationship",
      "text_document",
    ]);
    for (const update of updates) expect(declaredTypes).toContain(update.subject_type);

    const documentUpdate = updates.find((update) => update.subject_type === "text_document")!;
    expect(documentUpdate.subject_id).toBe(created.documentId);
    expect(documentUpdate.method).toBe("put");
    const documentFields = fieldsOf(documentUpdate);
    const content = documentFields["content"]!;
    if (!isFieldMap(content)) throw new Error("document content is not a map field");
    expect(Object.keys(content.map)).toEqual([initialRun.id]);
    expect(content.map[initialRun.id]!.value).toEqual(initialRun);
    expect(documentFields["version"]!.value).toBe(CURRENT_TEXT_VERSION);

    const relationship = updates.find((update) => update.subject_type === "relationship")!;
    const relationshipFields = fieldsOf(relationship);
    expect(relationshipFields["source_id"]!.value).toBe(created.noteId);
    expect(relationshipFields["target_id"]!.value).toBe(created.documentId);

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
    await waitForFlush(() => document.pendingActions());

    expect(document.text).toBe("Hello world!");
    expect(written).toHaveLength(before + 1);
    const edit = written[before]!.updates.find(
      (update) => update.subject_type === "text_document",
    )!;
    const content = fieldsOf(edit)["content"]!;
    if (!isFieldMap(content)) throw new Error("document content is not a map field");
    const [[, appended]] = Object.entries(content.map);
    expect(appended!.value as TextCell).toMatchObject({ kind: "run", text: "!" });
  });
});

describe("e.map()", () => {
  it("builds a string-keyed map schema", () => {
    const map = e.map(e.string());
    expect(map).toMatchObject({
      type: "object",
      patternProperties: { "^(.*)$": { type: "string" } },
    });
  });
});
