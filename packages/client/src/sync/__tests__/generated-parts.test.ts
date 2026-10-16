/**
 * Membership changes carry an entity's generated parts: the document
 * entities backing its derived collaborative-text fields, and their
 * generated edges. Domain relationships never travel (#474).
 *
 * The stub fetch records decoded Actions so every test asserts the
 * wire shape the move emits.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action, type Entity } from "@ebbjs/core";
import type { TSchema } from "@sinclair/typebox/type";

import { e, defineEntity, type EntityDef } from "../../schema/entity";
import { defineSchema, type Schema } from "../../schema/schema";
import { defineRelationship, type RelationshipDef } from "../../schema/relationship";
import { generatedDocEntityName } from "../../fields/collaborative-text/schema";
import { createClient, type NamespacedClient } from "../client";
import { readGeneratedParts } from "../generated-parts";
import { jsonResponse } from "../test-utils";

const author = defineEntity("author", { name: e.string() });
const blogPost = defineEntity("blog_post", {
  title: e.string(),
  body: e.collaborativeText(),
  subtitle: e.collaborativeText(),
});
const schema = defineSchema({
  entities: { author, blogPost },
  relationships: {
    blog_post_author: defineRelationship({ source: blogPost, target: author, as: "author" }),
  },
  version: 1,
});

const BODY_DOC = generatedDocEntityName("blog_post", "body");
const SUBTITLE_DOC = generatedDocEntityName("blog_post", "subtitle");

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

const PERMISSIONS = [
  "blog_post.*",
  BODY_DOC + ".*",
  SUBTITLE_DOC + ".*",
  "author.*",
  "shared_post.*",
  "shared_body.*",
  "relationship.*",
  "entityGroup.*",
];

type SyncUpdate = Action["updates"][number];

const fieldOf = (update: SyncUpdate, name: string): unknown => update.data?.fields?.[name]?.value;

const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/** Flatten one recorded request (an array of Actions) into its Updates. */
const updatesOf = (batch: readonly Action[]): readonly SyncUpdate[] =>
  batch.flatMap((action) => action.updates);

/** The `field` -> relationship id map a recorded Action carries. */
const relationshipIds = (updates: readonly SyncUpdate[]): Map<string, string> =>
  new Map(
    updates
      .filter((update) => update.subject_type === "relationship")
      .map((update) => [String(fieldOf(update, "field")), update.subject_id]),
  );

const mkClient = async <S extends AnySchema>(
  activeSchema: S,
): Promise<{
  client: NamespacedClient<S>;
  storage: Awaited<ReturnType<typeof import("@ebbjs/storage/memory").createMemoryAdapter>>;
  actions: Action[][];
}> => {
  const { createMemoryAdapter } = await import("@ebbjs/storage/memory");
  const storage = createMemoryAdapter();
  const actions: Action[][] = [];
  const fetchImpl = (async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/sync/handshake")) {
      return jsonResponse({
        actor_id: "actor_1",
        groups: [
          { id: "g_1", permissions: PERMISSIONS, cursor_valid: true, reason: null, cursor: 0 },
          { id: "g_2", permissions: PERMISSIONS, cursor_valid: true, reason: null, cursor: 0 },
        ],
      });
    }
    if (url.endsWith("/sync/actions")) {
      actions.push(decodeSync<{ actions: Action[] }>(init.body as unknown as Uint8Array).actions);
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    storage,
    schema: activeSchema,
    fetchImpl,
  });
  await client.handshake();
  return { client, storage, actions };
};

/**
 * Create a `blog_post` with two derived bodies in `groups`, then link a
 * domain `author` edge. The link is its own Action so the move can be
 * compared against it.
 */
const createPost = async (
  client: NamespacedClient<typeof schema>,
  groups: readonly string[] = ["g_1"],
): Promise<string> => {
  const { id } = await client.blogPost.create(
    { title: "Hello", body: "world", subtitle: "sub" },
    { groups },
  );
  await client.blogPost.link(id, "author", "au_1");
  return id;
};

const docIdsOf = (updates: readonly SyncUpdate[]): readonly string[] =>
  updates
    .filter((update) => update.subject_type.startsWith("text_document__"))
    .map((update) => update.subject_id);

describe("membership change carries generated parts (#474)", () => {
  it("moves the parent, its documents, and their edges; the domain edge stays put", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client);

    const createUpdates = updatesOf(actions[0]!);
    const createdRels = relationshipIds(createUpdates);
    expect([...createdRels.keys()].sort()).toEqual(["body", "subtitle"]);

    await client.blogPost.setGroups(id, ["g_2"]);

    const updates = updatesOf(actions[actions.length - 1]!);

    const groupPuts = updates.filter(
      (update) => update.subject_type === "entityGroup" && update.method === "put",
    );
    expect(groupPuts).toHaveLength(3);
    expect(groupPuts.map((update) => fieldOf(update, "entity_id")).sort()).toEqual(
      [id, ...docIdsOf(createUpdates)].sort(),
    );
    expect(groupPuts.every((update) => fieldOf(update, "group_id") === "g_2")).toBe(true);

    // Two edges re-emitted under their existing ids; the author edge is
    // a domain relationship and does not travel.
    const edgePuts = updates.filter((update) => update.subject_type === "relationship");
    expect(edgePuts).toHaveLength(2);
    expect(edgePuts.map((update) => update.subject_id).sort()).toEqual(
      [createdRels.get("body"), createdRels.get("subtitle")].sort(),
    );
    expect(edgePuts.map((update) => fieldOf(update, "field")).sort()).toEqual(["body", "subtitle"]);

    // The parent's and both documents' g_1 memberships are deleted.
    const deletes = updates.filter((update) => update.method === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.every((update) => update.subject_type === "entityGroup")).toBe(true);
  });

  it("carries the documents and edges into the added group", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client);

    await client.blogPost.addToGroup(id, "g_2");

    const updates = updatesOf(actions[actions.length - 1]!);
    const groupPuts = updates.filter((update) => update.subject_type === "entityGroup");
    expect(groupPuts).toHaveLength(3);
    expect(groupPuts.every((update) => fieldOf(update, "group_id") === "g_2")).toBe(true);
    expect(updates.filter((update) => update.subject_type === "relationship")).toHaveLength(2);
    expect(updates.filter((update) => update.method === "delete")).toHaveLength(0);
  });

  it("removes the documents' memberships with the parent's", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client, ["g_1", "g_2"]);

    await client.blogPost.removeFromGroup(id, "g_1");

    const updates = updatesOf(actions[actions.length - 1]!);
    const deletes = updates.filter((update) => update.method === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.every((update) => update.subject_type === "entityGroup")).toBe(true);
    // No group is added, so no edge is re-emitted.
    expect(updates.filter((update) => update.subject_type === "relationship")).toHaveLength(0);
  });

  it("resolves exactly the documents and edges its create emitted", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client);

    const createUpdates = updatesOf(actions[0]!);
    const parts = await readGeneratedParts(client.storage, client.registry, "blog_post", id);

    expect(parts.documents).toHaveLength(2);
    expect(parts.documents.map((document) => document.id).sort()).toEqual(
      [...docIdsOf(createUpdates)].sort(),
    );
    expect([...new Set(parts.documents.map((document) => document.type))].sort()).toEqual(
      [BODY_DOC, SUBTITLE_DOC].sort(),
    );

    expect(parts.edges).toHaveLength(2);
    expect(parts.edges.map((edge) => edge.relationshipId).sort()).toEqual(
      [...relationshipIds(createUpdates).values()].sort(),
    );
    expect(parts.edges.map((edge) => edge.field).sort()).toEqual(["body", "subtitle"]);
    expect(parts.edges.every((edge) => edge.sourceId === id)).toBe(true);
  });

  it("dedupes a document shared by two derived fields", async () => {
    const sharedPost = defineEntity("shared_post", {
      title: e.string(),
      body: e.collaborativeText({ entity: "shared_body" }),
      subtitle: e.collaborativeText({ entity: "shared_body" }),
    });
    const sharedSchema = defineSchema({ entities: { sharedPost }, version: 1 });
    const { client, storage } = await mkClient(sharedSchema);

    // Two derived fields whose edges resolve to the same document entity.
    await storage.entities.set(
      mkEntity("rel_body", "relationship", {
        source_id: "post_1",
        target_id: "doc_shared",
        field: "body",
        type: "shared_post",
      }),
    );
    await storage.entities.set(
      mkEntity("rel_subtitle", "relationship", {
        source_id: "post_1",
        target_id: "doc_shared",
        field: "subtitle",
        type: "shared_post",
      }),
    );
    await storage.entities.set(
      mkEntity("eg_doc", "entityGroup", { entity_id: "doc_shared", group_id: "g_1" }),
    );

    const parts = await readGeneratedParts(
      client.storage,
      client.registry,
      "shared_post",
      "post_1",
    );

    expect(parts.documents).toHaveLength(1);
    expect(parts.documents[0]).toEqual({
      id: "doc_shared",
      type: "shared_body",
      memberships: [{ membershipId: "eg_doc", groupId: "g_1" }],
    });
    expect(parts.edges.map((edge) => edge.field).sort()).toEqual(["body", "subtitle"]);
    expect(new Set(parts.edges.map((edge) => edge.targetId))).toEqual(new Set(["doc_shared"]));
  });
});

describe("draft membership verbs carry generated parts (#474)", () => {
  it("carries the documents and edges on a draft addToGroup", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client);

    await client.atomic(({ blogPost: draft }) => {
      draft.addToGroup(id, "g_2");
    });

    const updates = updatesOf(actions[actions.length - 1]!);
    const groupPuts = updates.filter((update) => update.subject_type === "entityGroup");
    expect(groupPuts).toHaveLength(3);
    expect(groupPuts.every((update) => fieldOf(update, "group_id") === "g_2")).toBe(true);
    expect(updates.filter((update) => update.subject_type === "relationship")).toHaveLength(2);
  });

  it("removes the documents' memberships on a draft removeFromGroup", async () => {
    const { client, actions } = await mkClient(schema);
    const id = await createPost(client, ["g_1", "g_2"]);

    await client.atomic(({ blogPost: draft }) => {
      draft.removeFromGroup(id, "g_1");
    });

    const updates = updatesOf(actions[actions.length - 1]!);
    const deletes = updates.filter((update) => update.method === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.every((update) => update.subject_type === "entityGroup")).toBe(true);
    expect(updates.filter((update) => update.subject_type === "relationship")).toHaveLength(0);
  });
});
