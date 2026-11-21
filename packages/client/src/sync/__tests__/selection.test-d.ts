/**
 * Type-level component selection (#940): checked by `tsc --noEmit`.
 *
 * `select` takes field keys of the row, narrows the projection it returns, and
 * rejects a key the model does not declare or a value other than `true`.
 */

import { describe, it } from "vitest";

import { defineModel, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";

const note = defineModel("note", {
  title: e.string(),
  status: e.string(),
  body: e.string(),
});

const schema = defineSchema({ models: { note }, version: 1 });

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T => true as T;

const client = createClient({ serverUrl: "http://x", actorId: "actor_1", schema });

describe("select typing", () => {
  it("narrows a query row to the selected fields plus the structural keys", async () => {
    const rows = await client.note.query().select({ title: true, status: true });
    type Keys = keyof (typeof rows)[number];
    assertTrue<Equal<Keys, "title" | "status" | "id" | "groupIds">>();

    const one = await client.note.query().select({ title: true });
    type OneKeys = keyof (typeof one)[number];
    assertTrue<Equal<OneKeys, "title" | "id" | "groupIds">>();

    const structural = await client.note.query().select({});
    type StructuralKeys = keyof (typeof structural)[number];
    assertTrue<Equal<StructuralKeys, "id" | "groupIds">>();
  });

  it("narrows a get row to the selected fields plus its handle", async () => {
    const row = await client.note.get("note_1", { select: { title: true } });
    type Row = NonNullable<typeof row>;
    type FieldKeys = Exclude<keyof Row, "id" | "groups" | "subscribe" | "subscribeAccessors">;
    assertTrue<Equal<FieldKeys, "title">>();
  });

  it("rejects an unknown field and a non-true value", () => {
    const invoke = () => {
      // @ts-expect-error — `nope` is not a field of the model
      client.note.query().select({ nope: true });
      // @ts-expect-error — a selection value is exactly `true`
      client.note.query().select({ title: "yes" });
      // @ts-expect-error — `nope` is not a field of the model
      void client.note.get("note_1", { select: { nope: true } });
      // @ts-expect-error — a get selection is required
      void client.note.get("note_1", {});
    };
    void invoke;
  });
});
