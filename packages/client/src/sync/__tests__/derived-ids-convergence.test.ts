/**
 * Two clients deriving the same missing body must address one row set
 * (#695).
 *
 * The rows a derived body implies are created by whichever client first
 * finds them missing, and the two never compare notes about that decision.
 * If the ids were minted, each would install its own document, its own
 * relationship, and its own membership rows, and the text would split. So
 * the assertion here is material: two independent writers — different
 * actors, clocks, and update ids — folding their Actions into one store
 * produce one document, one relationship, one membership per group, and
 * the seed text exactly once.
 *
 * Both writers go through `createEntity` with the same parent id, which is
 * the shape #696's backfill will use for the rows themselves. The backfill
 * will stop at the derived rows; `createEntity` also writes the parent, so
 * both writers put that row too — harmless here because they assert the
 * same parent fields, and asserted below rather than assumed away.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { defineEntity, e } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { derivedDocumentId, derivedRelationshipId } from "@ebbjs/schema";
import { generatedDocEntityName } from "@ebbjs/schema";
import { parseContentField } from "@ebbjs/schema";
import { commit, type CommitCapability } from "@ebbjs/write";
import { call, createEntity } from "@ebbjs/write";
import { createClient } from "../client";
import { jsonResponse } from "../test-utils";

const blogPost = defineEntity("blog_post", {
  title: e.string(),
  body: e.collaborativeText(),
});
const schema = defineSchema({ entities: { blogPost }, version: 1 });

/** The parent both writers derive the body for. Same id on both sides. */
const PARENT_ID = "e_shared_parent";
const GROUP_ID = "g_1";
const DOC_TYPE = generatedDocEntityName("blog_post", "body");
const SEED = "shared seed";

/**
 * One writer: a client with its own actor, clock, and update-id stream,
 * whose committed Actions are captured instead of reaching a server.
 */
const writer = async (actorId: string) => {
  const storage = createMemoryAdapter();
  const written: Action[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/sync/handshake")) {
      return jsonResponse({
        actor_id: actorId,
        groups: [
          {
            id: GROUP_ID,
            permissions: ["blog_post.*", `${DOC_TYPE}.*`, "relationship.*", "entityGroup.*"],
            cursor_valid: true,
            reason: null,
            cursor: 0,
          },
        ],
      });
    }
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
    actorId,
    storage,
    schema,
    fetchImpl,
  });
  await client.handshake();

  const capability: CommitCapability = {
    registry: client.registry,
    submitRelationshipUpdates: (updates) => client.submitRelationshipUpdates(updates),
    freshHlc: () => client.freshHlc(),
    generateUpdateId: () => client.generateUpdateId(),
    actorId: client.actorId,
  };

  await commit(
    [
      call(createEntity, {
        entity: "blog_post",
        id: PARENT_ID,
        fields: { title: "Shared" },
        bodies: { body: SEED },
        groups: [GROUP_ID],
      }),
    ],
    capability,
  );

  return { written, client };
};

const fold = async (actions: readonly Action[]) => {
  const storage = createMemoryAdapter();
  for (const action of actions) await storage.actions.append(action);
  return storage;
};

const bothWriters = async () => {
  const a = await writer("actor_a");
  const b = await writer("actor_b");
  return { a, b, storage: await fold([...a.written, ...b.written]) };
};

describe("two writers deriving one missing body", () => {
  it("mints distinct update ids, so the writers are genuinely independent", async () => {
    const { a, b } = await bothWriters();

    const updateIds = (actions: readonly Action[]) =>
      actions.flatMap((action) => action.updates.map((update) => update.id));
    const idsA = updateIds(a.written);
    const idsB = updateIds(b.written);

    expect(idsA).not.toHaveLength(0);
    expect(idsB).not.toHaveLength(0);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
  });

  it("addresses the same document and the same relationship", async () => {
    const { a, b } = await bothWriters();

    const subjectsOf = (actions: readonly Action[]) =>
      actions.flatMap((action) =>
        action.updates.map((update) => `${update.subject_type}:${update.subject_id}`),
      );

    expect(new Set(subjectsOf(a.written))).toEqual(new Set(subjectsOf(b.written)));
  });

  it("converges on one document, one relationship, and one membership per group", async () => {
    const { storage } = await bothWriters();

    const parents = await storage.entities.query("blog_post");
    expect(parents.map((row) => row.id)).toEqual([PARENT_ID]);

    const documents = await storage.entities.query(DOC_TYPE);
    expect(documents.map((row) => row.id)).toEqual([
      derivedDocumentId(PARENT_ID, "body", DOC_TYPE),
    ]);

    const relationships = await storage.entities.query("relationship");
    expect(relationships.map((row) => row.id)).toEqual([derivedRelationshipId(PARENT_ID, "body")]);
    expect(relationships[0]!.deleted_hlc).toBeNull();

    // The parent's own membership plus the document's, one row each.
    const memberships = await storage.entities.query("entityGroup");
    expect(memberships).toHaveLength(2);
    expect(new Set(memberships.map((row) => row.id)).size).toBe(2);
    expect(
      memberships.map((row) => row.data.fields["group_id"]!.value).every((g) => g === GROUP_ID),
    ).toBe(true);
  });

  it("lands the seed text exactly once", async () => {
    const { storage } = await bothWriters();

    // Counted across every document row, so a split shows up as two seeds
    // rather than hiding inside whichever row the query returned first.
    const documents = await storage.entities.query(DOC_TYPE);
    const live = documents.flatMap((document) =>
      [...parseContentField(document.data.fields["content"]).values()].filter(
        (run) => run.value !== null && !run.value.deleted,
      ),
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.value!.text).toBe(SEED);
  });
});
