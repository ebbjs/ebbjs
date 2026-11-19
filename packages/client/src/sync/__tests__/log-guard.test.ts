/**
 * The registry-driven append-only guard (#778).
 *
 * `SyncClient.write` refuses a write that rewrites an entry of a declared log
 * component, and it does so before the Action reaches the outbox. Nothing in
 * these tests mentions text: the model declares an `e.log`, and the client
 * learns the entry shape from nowhere — the entries below are plain objects.
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, makeHlc, type Action, type FieldValue } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { AppendOnlyViolationError, defineModel, defineSchema, e } from "@ebbjs/schema";
import { createClient } from "../client";
import { callApplyAction, jsonResponse, stampedRow } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const entrySchema = Type.Object({ text: Type.String() });

const note = defineModel("note", {
  entries: e.log(entrySchema),
  plain: e.map(entrySchema),
});

const schema = defineSchema({ models: { note }, version: 1 });

const HANDSHAKE = {
  actor_id: ACTOR_ID,
  groups: [
    {
      id: "g_1",
      permissions: ["note.*"],
      cursor_valid: true,
      reason: null,
      cursor: 0,
    },
  ],
};

interface Harness {
  readonly client: ReturnType<typeof createClient>;
  readonly storage: ReturnType<typeof createMemoryAdapter>;
  /** Decoded Action batches the stub accepted on `/sync/actions`. */
  readonly submitted: Action[][];
}

const harness = (): Harness => {
  const storage = createMemoryAdapter();
  const submitted: Action[][] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/sync/handshake")) return jsonResponse(HANDSHAKE);
    if (url.endsWith("/sync/actions")) {
      if (init?.body instanceof Uint8Array) {
        submitted.push(decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
  const client = createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    schema,
    fetchImpl,
  });
  return { client, storage, submitted };
};

const HLC = makeHlc(1_711_036_800_000);
const LATER_HLC = makeHlc(1_711_036_800_001);

/** One entry of a keyed map component. */
const entry = (text: string, updateId: string, hlc: string = HLC): FieldValue => ({
  value: { text },
  update_id: updateId,
  hlc,
});

/** A component's map value, keyed by entry id. */
const mapOf = (entries: Record<string, FieldValue>): FieldValue => ({ map: entries });

/** A merge write to one of the note's components. */
const componentWrite = (args: {
  actionId: string;
  subjectId: string;
  field: string;
  data: FieldValue;
  hlc?: string;
}): Action => ({
  id: args.actionId,
  actor_id: ACTOR_ID,
  hlc: args.hlc ?? HLC,
  gsn: 0,
  updates: [
    {
      id: `${args.actionId}_0`,
      subject_id: args.subjectId,
      component: `note/${args.field}`,
      method: "merge",
      data: args.data,
    },
  ],
});

/** Every component name a submitted batch carried. */
const submittedComponents = (harness: Harness): string[] =>
  harness.submitted.flatMap((batch) =>
    batch.flatMap((action) =>
      action.updates.flatMap((update) => ("component" in update ? [update.component] : [])),
    ),
  );

/** The refusal `write` raises, or `undefined` when the batch lands. */
const refusalOf = async (harness: Harness, action: Action): Promise<unknown> => {
  try {
    await harness.client.write([action]);
    return undefined;
  } catch (error) {
    return error;
  }
};

/** Fold an Action into the client's replica the way an inbound delivery does. */
const seedReplica = async (
  harness: Harness,
  args: { field: string; entries: Record<string, FieldValue>; subjectId?: string },
): Promise<void> => {
  await callApplyAction(
    harness.client,
    componentWrite({
      actionId: "act_seed",
      subjectId: args.subjectId ?? "note_1",
      field: args.field,
      data: mapOf(args.entries),
    }),
    "g_1",
  );
};

describe("the append-only guard", () => {
  it("accepts an append and sends it to the server", async () => {
    const h = harness();
    await h.client.handshake();

    const append = componentWrite({
      actionId: "act_append",
      subjectId: "note_1",
      field: "entries",
      data: mapOf({ a: entry("first", "u_a") }),
    });

    await expect(h.client.write([append])).resolves.toEqual({ rejected: [] });
    expect(submittedComponents(h)).toContain("note/entries");
  });

  it("refuses a rewrite of a key the replica holds, before queueing", async () => {
    const h = harness();
    await h.client.handshake();
    await seedReplica(h, { field: "entries", entries: { a: entry("first", "u_a") } });

    const queuedBefore = h.client.outbox.size();
    const submittedBefore = h.submitted.length;

    const rewrite = componentWrite({
      actionId: "act_rewrite",
      subjectId: "note_1",
      field: "entries",
      data: mapOf({ a: entry("changed", "u_rewrite", LATER_HLC) }),
      hlc: LATER_HLC,
    });

    const refusal = await refusalOf(h, rewrite);
    expect(refusal).toBeInstanceOf(AppendOnlyViolationError);
    expect(refusal).toMatchObject({ component: "note/entries", keys: ["a"] });
    expect(h.client.outbox.size()).toBe(queuedBefore);
    expect(h.submitted).toHaveLength(submittedBefore);
  });

  it("accepts an identical value under a new envelope as re-delivery", async () => {
    const h = harness();
    await h.client.handshake();
    await seedReplica(h, { field: "entries", entries: { a: entry("first", "u_a") } });

    const redelivery = componentWrite({
      actionId: "act_redelivery",
      subjectId: "note_1",
      field: "entries",
      data: mapOf({ a: entry("first", "u_again", LATER_HLC) }),
      hlc: LATER_HLC,
    });

    await expect(h.client.write([redelivery])).resolves.toEqual({ rejected: [] });
    expect(submittedComponents(h)).toContain("note/entries");
  });

  it("refuses a rewrite whose key exists only in storage", async () => {
    const h = harness();
    await h.client.handshake();

    // The replica never carries this row, so only the durable copy knows `a`.
    await h.storage.entities.set(
      stampedRow("note_2", "note", { entries: mapOf({ a: entry("stored", "u_stored") }) }),
    );

    const queuedBefore = h.client.outbox.size();
    const rewrite = componentWrite({
      actionId: "act_stored_rewrite",
      subjectId: "note_2",
      field: "entries",
      data: mapOf({ a: entry("changed", "u_rewrite", LATER_HLC) }),
      hlc: LATER_HLC,
    });

    const refusal = await refusalOf(h, rewrite);
    expect(refusal).toBeInstanceOf(AppendOnlyViolationError);
    expect(refusal).toMatchObject({ component: "note/entries", keys: ["a"] });
    expect(h.client.outbox.size()).toBe(queuedBefore);
  });

  it("does not guard a plain e.map component carrying the same data", async () => {
    const h = harness();
    await h.client.handshake();
    await seedReplica(h, { field: "plain", entries: { a: entry("first", "u_a") } });

    const rewrite = componentWrite({
      actionId: "act_plain_rewrite",
      subjectId: "note_1",
      field: "plain",
      data: mapOf({ a: entry("changed", "u_rewrite", LATER_HLC) }),
      hlc: LATER_HLC,
    });

    await expect(h.client.write([rewrite])).resolves.toEqual({ rejected: [] });
    expect(submittedComponents(h)).toContain("note/plain");
  });
});
