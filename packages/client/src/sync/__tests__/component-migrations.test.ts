/**
 * Per-component read migrations (#804): only the component whose declaration
 * moved forward is migrated, and a stored version newer than the client's fails.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type FieldValue } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { ReplicaRecord } from "@ebbjs/storage/types";
import { defineComponent, defineMigration, defineModel, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { ComponentVersionAheadError } from "../migrations";
import { callApplyAction } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const label = (version: number) => defineComponent("note/label", e.map(e.string()), { version });

const noteSchema = (version: number, migrations = [renameLabel()]) =>
  defineSchema({
    models: {
      note: defineModel("note", {
        label: label(version),
        status: e.string(),
      }),
    },
    version: 1,
    migrations,
  });

type TestSchema = ReturnType<typeof noteSchema>;

function renameLabel() {
  return defineMigration("note/label", 1, 2, (value) => {
    const entries = value as Record<string, unknown>;
    if (!("name" in entries)) return entries;
    const { name, ...rest } = entries;
    return { ...rest, title: name };
  });
}

const leaf = (value: unknown, updateId: string, ms: number): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

const recordWith = (labelValue: FieldValue, storedVersion: number): ReplicaRecord => ({
  format: 4,
  position: 1,
  revision: 1,
  entities: [
    {
      id: "note_1",
      type: "note",
      data: {
        fields: {
          label: labelValue,
          status: leaf("open", "u_status", 1),
        },
      },
      exists: true,
      created_hlc: makeHlc(1),
      updated_hlc: makeHlc(1),
      deleted_hlc: null,
      last_gsn: 1,
    },
  ],
  componentVersions: {
    note_1: { "note/label": storedVersion, "note/status": 1 },
  },
});

const mkClient = (storage: ReturnType<typeof createMemoryAdapter>, schema: TestSchema) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    schema,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ rejected: [] }), { status: 200 })) as unknown as typeof fetch,
  });

const writeLabel = (value: FieldValue): Action => ({
  id: "a_1",
  actor_id: ACTOR_ID,
  hlc: makeHlc(2),
  gsn: 1,
  updates: [
    {
      id: "u_label",
      subject_id: "note_1",
      component: "note/label",
      method: "merge",
      data: value,
    },
  ],
});

describe("component read migrations (#804)", () => {
  it("migrates one component without touching its sibling", async () => {
    const storage = createMemoryAdapter();
    await storage.replica.save(recordWith({ map: { name: leaf("Old", "u_label", 1) } }, 1));
    const client = mkClient(storage, noteSchema(2));

    const [row] = await client.note.query();
    expect(row?.label).toEqual({ title: "Old" });
    expect(row?.status).toBe("open");
  });

  it("leaves a component already at the declared version untouched", async () => {
    const storage = createMemoryAdapter();
    await storage.replica.save(recordWith({ map: { title: leaf("Current", "u_label", 1) } }, 2));
    const client = mkClient(storage, noteSchema(2));

    const [row] = await client.note.query();
    expect(row?.label).toEqual({ title: "Current" });
  });

  it("runs a multi-step chain in order", async () => {
    const storage = createMemoryAdapter();
    await storage.replica.save(recordWith({ map: { name: leaf("Old", "u_label", 1) } }, 1));
    const schema = noteSchema(3, [
      renameLabel(),
      defineMigration("note/label", 2, 3, (value) => ({
        ...(value as object),
        title: `${String((value as { title: unknown }).title)} v3`,
      })),
    ]);
    const client = mkClient(storage, schema);

    const [row] = await client.note.query();
    expect(row?.label).toEqual({ title: "Old v3" });
  });

  it("projects migrated values into a collection subscribe snapshot", async () => {
    const storage = createMemoryAdapter();
    await storage.replica.save(recordWith({ map: { name: leaf("Old", "u_label", 1) } }, 1));
    const client = mkClient(storage, noteSchema(2));
    await client.hydrateReplica();

    const seen: { id: string; label: unknown }[][] = [];
    const unsubscribe = client.note.subscribe({}, (snapshot) => {
      seen.push(snapshot.entities.map((row) => ({ id: row.id, label: row.label })));
    });

    await callApplyAction(
      client,
      {
        id: "a_2",
        actor_id: ACTOR_ID,
        hlc: makeHlc(2),
        gsn: 2,
        updates: [
          {
            id: "u_2_label",
            subject_id: "note_2",
            component: "note/label",
            method: "merge",
            data: { map: { title: leaf("New", "u_2_label", 2) } },
          },
          {
            id: "u_2_status",
            subject_id: "note_2",
            component: "note/status",
            method: "replace",
            data: leaf("open", "u_2_status", 2),
          },
        ],
      },
      "grp_1",
    );

    const labels = Object.fromEntries((seen.at(-1) ?? []).map((row) => [row.id, row.label]));
    expect(labels.note_1).toEqual({ title: "Old" });
    expect(labels.note_2).toEqual({ title: "New" });
    unsubscribe();
  });

  it("does not migrate a component this session materialized", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, noteSchema(2));
    await client.hydrateReplica();
    const action = writeLabel({ map: { title: leaf("New", "u_label", 2) } });
    client.replica.ingest(action, action.updates, 1);

    const [row] = await client.note.query();
    expect(row?.label).toEqual({ title: "New" });
  });

  it("fails loudly when a stored component is newer than the declaration", async () => {
    const storage = createMemoryAdapter();
    await storage.replica.save(recordWith({ map: { title: leaf("Future", "u_label", 1) } }, 3));
    const client = mkClient(storage, noteSchema(2));
    await client.hydrateReplica();

    await expect(client.note.query()).rejects.toBeInstanceOf(ComponentVersionAheadError);
  });
});
