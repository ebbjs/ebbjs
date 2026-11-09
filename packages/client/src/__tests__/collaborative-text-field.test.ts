/**
 * Acceptance tests for the derived collaborative-text body
 * (`e.collaborativeText()`) — issue #152.
 *
 * Covers the client-side contract end to end without a live server:
 * schema sugar and expansion, the one-Action create, hydration through
 * `row.<body>`, independent bodies, custom document entity names, and
 * self-flushing local edits reaching a second client.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, makeHlc, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { TSchema } from "@sinclair/typebox/type";

import { e, defineEntity, type EntityDef } from "@ebbjs/schema";
import { EntityValidationError, validatePayload } from "@ebbjs/schema";
import { defineRelationship, type RelationshipDef } from "@ebbjs/schema";
import { defineSchema, type Schema } from "@ebbjs/schema";
import { ConflictScopeMismatchError, DerivedDocNameCollisionError } from "@ebbjs/schema";
import { generatedDocEntityName, TextCellSchema } from "@ebbjs/schema";
import { derivedDocumentId, derivedRelationshipId } from "@ebbjs/schema";
import { entityGroupId } from "@ebbjs/write";
import { createClient } from "../sync/client";
import { AppendOnlyViolationError } from "@ebbjs/schema";
import { callApplyAction, jsonResponse } from "../sync/test-utils";
import { testActions } from "../sync/__tests__/test-actions";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HANDSHAKE = {
  actor_id: "actor_1",
  groups: ["g_1", "g_2"].map((id) => ({
    id,
    permissions: [
      "blog_post.*",
      "text_document.*",
      "text_document__blog_post__body.*",
      "text_document__article__body.*",
      "text_document__article__subtitle.*",
      "article.*",
      "post.*",
      "article_body.*",
      "note.*",
      "shared_body.*",
      "relationship.*",
      "entityGroup.*",
    ],
    cursor_valid: true,
    reason: null,
    cursor: 0,
  })),
};

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

function harness<S extends AnySchema>(activeSchema: S, actorId = "actor_1") {
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
    actorId,
    storage,
    schema: activeSchema,
    actions: testActions(activeSchema),
    fetchImpl,
  });
  return { client, written };
}

const waitForFlush = async (pending: () => readonly Action[]): Promise<void> => {
  for (let i = 0; i < 50 && pending().length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/**
 * Structural view of an Action with minted ids, HLCs, and run ids
 * normalized away, so two runs of the same write compare equal. Run
 * ids shout through as map keys on `content`; the value's text is what
 * the equivalence is about.
 */
const canonicalize = (action: Action): unknown => {
  const ids = new Map<string, string>();
  const idOf = (id: string): string => {
    const existing = ids.get(id);
    if (existing !== undefined) return existing;
    const next = `id_${ids.size}`;
    ids.set(id, next);
    return next;
  };
  const canonicalFields = (fields: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, env] of Object.entries(fields)) {
      const field = env as {
        value?: unknown;
        map?: Record<string, { value?: { text?: string } }>;
      };
      if (key === "content") {
        out[key] = Object.values(field.map ?? {})
          .map((entry) => entry.value?.text ?? null)
          .sort();
        continue;
      }
      out[key] =
        key === "source_id" || key === "target_id" || key === "entity_id"
          ? idOf(field.value as string)
          : field.value;
    }
    return out;
  };
  return action.updates
    .map((update) => ({
      subject_id: idOf(update.subject_id),
      subject_type: update.subject_type,
      method: update.method,
      fields: canonicalFields(update.data?.fields ?? {}),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

// ---------------------------------------------------------------------------
// Schema sugar
// ---------------------------------------------------------------------------

const blogPost = defineEntity("blog_post", {
  title: e.string(),
  published: e.boolean(),
  body: e.collaborativeText(),
});

const schema = defineSchema({ entities: { blogPost }, version: 1 });

/** The same body declared at entity scope: any concurrent touch surfaces. */
const entityPost = defineEntity("blog_post", {
  title: e.string(),
  published: e.boolean(),
  body: e.collaborativeText({ conflictScope: "entity" }),
});
const entitySchema = defineSchema({ entities: { entityPost }, version: 1 });

describe("e.collaborativeText() schema sugar", () => {
  it("hoists the declared body out of the parent's wire shape", () => {
    expect(Object.keys(blogPost.shape.properties)).toEqual(["title", "published"]);
    expect(Object.keys(blogPost.fields)).toEqual(["title", "published"]);
    expect(blogPost.derived).toEqual({
      body: { kind: "collaborative-text", entity: undefined, conflictScope: "field" },
    });
  });

  it("expands into a generated document entity and a collaborative-text relationship", () => {
    const docName = generatedDocEntityName("blog_post", "body");
    expect(docName).toBe("text_document__blog_post__body");
    expect(schema.entities["text_document__blog_post__body"]).toBeDefined();
    expect(Object.keys(schema.entities)).toContain("blogPost");
    const rel = schema._registry.getRelationship("blog_post", "body");
    expect(rel).toBeDefined();
    expect(rel!.target.name).toBe(docName);
    expect(rel!.kind).toBe("collaborative-text");
    expect(rel!.sourceCardinality).toBe("one");
  });

  it("refuses a derived field that collides with a declared relationship accessor", () => {
    const other = defineEntity("other", { name: e.string() });
    const withCollision = defineEntity("post", { body: e.collaborativeText() });
    expect(() =>
      defineSchema({
        entities: { post: withCollision, other },
        relationships: {
          post_other: defineRelationship({ source: withCollision, target: other, as: "body" }),
        },
        version: 1,
      }),
    ).toThrow(/derived field "body"/);
  });

  it("does not disturb a schema with no derived fields", () => {
    const plain = defineSchema({
      entities: { other: defineEntity("other", { name: e.string() }) },
      version: 1,
    });
    expect(plain.relationships).toBeUndefined();
    expect(Object.keys(plain.entities)).toEqual(["other"]);
  });

  it("rejects a body that reaches validatePayload as a wire field", () => {
    const violations = validatePayload(
      blogPost.shape,
      { title: "x", published: false, body: "y" },
      "blog_post",
      false,
    );
    expect(violations.some((v) => v.field === "body")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// e.map()
// ---------------------------------------------------------------------------

describe("e.map()", () => {
  it("builds a string-keyed map schema", () => {
    const map = e.map(e.string());
    expect(map).toMatchObject({
      type: "object",
      patternProperties: { "^(.*)$": { type: "string" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("create() with a derived body", () => {
  it("emits the parent, document, relationship, and memberships in one Action", async () => {
    const { client, written } = harness(schema);
    await client.handshake();

    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "Hello", published: false, body: "world" },
      groups: ["g_1"],
    });

    expect(id).toMatch(/^e_/);
    expect(written).toHaveLength(1);

    const updates = written[0]!.updates;
    const byType = (type: string): typeof updates => updates.filter((u) => u.subject_type === type);
    const docName = generatedDocEntityName("blog_post", "body");

    expect(byType("blog_post")).toHaveLength(1);
    expect(byType(docName)).toHaveLength(1);
    expect(byType("relationship")).toHaveLength(1);
    expect(byType("entityGroup")).toHaveLength(2);

    const docUpdate = byType(docName)[0]!;
    const content = (
      docUpdate.data as unknown as { fields: { content: { map: Record<string, unknown> } } }
    ).fields.content;
    const runIds = Object.keys(content.map);
    expect(runIds).toHaveLength(1);
    expect((content.map[runIds[0]!] as { value: { text: string } }).value.text).toBe("world");
  });

  it("leaves the body unlinked when the derived value is omitted", async () => {
    const { client } = harness(schema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "No body", published: false },
      groups: ["g_1"],
    });
    const row = await client.blogPost.get(id);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("No body");
    expect(await row!.body).toBeNull();
  });

  it("refuses a non-string derived body", async () => {
    const { client } = harness(schema);
    await client.handshake();
    await expect(
      client.actions.create({
        entity: "blogPost",
        input: { title: "T", published: false, body: 42 },
        groups: ["g_1"],
      }),
    ).rejects.toBeInstanceOf(EntityValidationError);
  });
});

describe("drafts through a mounted action", () => {
  it("expands a derived body through the same create operation as the named-action path", async () => {
    const { client, written } = harness(schema);
    await client.handshake();

    const created = await client.actions.run(({ blogPost }) =>
      blogPost.create({ title: "T", published: false, body: "x" }, { groups: ["g_1"] }),
    );

    expect(created.id).toMatch(/^e_/);
    expect(written).toHaveLength(1);
    const updates = written[0]!.updates;
    const byType = (type: string): typeof updates => updates.filter((u) => u.subject_type === type);
    const docName = generatedDocEntityName("blog_post", "body");

    expect(byType("blog_post")).toHaveLength(1);
    expect(byType(docName)).toHaveLength(1);
    expect(byType("relationship")).toHaveLength(1);
    expect(byType("entityGroup")).toHaveLength(2);

    const docUpdate = byType(docName)[0]!;
    const content = (
      docUpdate.data as unknown as { fields: { content: { map: Record<string, unknown> } } }
    ).fields.content;
    const runIds = Object.keys(content.map);
    expect(runIds).toHaveLength(1);
    expect((content.map[runIds[0]!] as { value: { text: string } }).value.text).toBe("x");
  });

  it("composes a structurally identical Action on every run, with fresh ids", async () => {
    const { client, written } = harness(schema);
    await client.handshake();

    const input = { title: "T", published: false, body: "x" };
    const first = await client.actions.create({ entity: "blogPost", input, groups: ["g_1"] });
    const second = await client.actions.create({ entity: "blogPost", input, groups: ["g_1"] });

    expect(first.id).not.toBe(second.id);

    expect(written).toHaveLength(2);
    expect(canonicalize(written[0]!)).toEqual(canonicalize(written[1]!));
  });

  it("names the same derived ids in the batch overlay as on the wire", async () => {
    // A membership verb later in the batch files the derived document into
    // its new groups and re-emits the relationship, all from the overlay the
    // planner built at `create` time. If the planner derived a different
    // document id than the create operation, those rows would name a
    // document that never exists.
    const { client, written } = harness(schema);
    await client.handshake();

    const created = await client.actions.run(({ blogPost }) => {
      const post = blogPost.create(
        { title: "T", published: false, body: "x" },
        { groups: ["g_1"] },
      );
      blogPost.addToGroup(post.id, "g_2");
      return post;
    });

    const docName = generatedDocEntityName("blog_post", "body");
    const docId = derivedDocumentId(created.id, "body", docName);
    const relationshipId = derivedRelationshipId(created.id, "body");
    const updates = written.flatMap((action) => action.updates);

    expect(updates.filter((u) => u.subject_type === docName).map((u) => u.subject_id)).toEqual([
      docId,
    ]);
    expect(
      new Set(updates.filter((u) => u.subject_type === "relationship").map((u) => u.subject_id)),
    ).toEqual(new Set([relationshipId]));
    expect(
      updates
        .filter((u) => u.subject_type === "entityGroup")
        .map((u) => u.subject_id)
        .filter((id) => id.includes(docId))
        .sort(),
    ).toEqual([entityGroupId(docId, "g_1"), entityGroupId(docId, "g_2")].sort());
  });
});

describe("duplicate() backs up a derived body", () => {
  it("copies the generated document entity's content map through its namespace", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    await client.actions.create({
      entity: "blogPost",
      input: { title: "Hello", published: false, body: "world" },
      groups: ["g_1"],
    });

    const docName = generatedDocEntityName("blog_post", "body");
    const docId = written[0]!.updates.find((u) => u.subject_type === docName)!.subject_id;
    const docNamespace = client["text_document__blog_post__body"];

    const { id: backupId } = await client.actions.duplicate({
      entity: "text_document__blog_post__body",
      id: docId,
    });

    type DocRow = { content: Record<string, unknown> };
    const original = (await docNamespace.get(docId)) as unknown as DocRow;
    const backup = (await docNamespace.get(backupId)) as unknown as DocRow;
    const runId = Object.keys(original.content)[0]!;
    expect(backupId).not.toBe(docId);
    expect(Object.keys(backup.content)).toEqual(Object.keys(original.content));
    expect((backup.content[runId] as { text: string }).text).toBe("world");
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("row.<body> hydration", () => {
  it("resolves a hydrated TextDocument with the created text", async () => {
    const { client } = harness(schema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "Hello", published: false, body: "world" },
      groups: ["g_1"],
    });

    const row = await client.blogPost.get(id);
    expect(row!.title).toBe("Hello");
    expect(row!.published).toBe(false);

    const doc = await row!.body;
    expect(doc).not.toBeNull();
    expect(doc!.text).toBe("world");
  });

  it("keeps document data off the query row", async () => {
    const { client } = harness(schema);
    await client.handshake();
    await client.actions.create({
      entity: "blogPost",
      input: { title: "A", published: false, body: "one" },
      groups: ["g_1"],
    });
    await client.actions.create({
      entity: "blogPost",
      input: { title: "B", published: false, body: "two" },
      groups: ["g_1"],
    });

    const rows = await client.blogPost.query();
    expect(rows.map((r) => r.title).sort()).toEqual(["A", "B"]);
    expect((rows[0] as unknown as Record<string, unknown>)["body"]).toBeUndefined();
    expect((rows[0] as unknown as Record<string, unknown>)["content"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple bodies / custom entity
// ---------------------------------------------------------------------------

describe("multiple bodies and custom document entities", () => {
  it("resolves two bodies on one entity independently", async () => {
    const withTwo = defineEntity("article", {
      title: e.string(),
      body: e.collaborativeText(),
      subtitle: e.collaborativeText(),
    });
    const twoSchema = defineSchema({ entities: { article: withTwo }, version: 1 });
    const { client } = harness(twoSchema);
    await client.handshake();

    const { id } = await client.actions.create({
      entity: "article",
      input: { title: "T", body: "main", subtitle: "sub" },
      groups: ["g_1"],
    });
    const row = await client.article.get(id);
    expect((await row!.body)!.text).toBe("main");
    expect((await row!.subtitle)!.text).toBe("sub");
  });

  it("uses the custom document entity name for the generated subject type", async () => {
    const custom = defineEntity("post", {
      title: e.string(),
      body: e.collaborativeText({ entity: "article_body" }),
    });
    const customSchema = defineSchema({ entities: { post: custom }, version: 1 });
    const { client, written } = harness(customSchema);
    await client.handshake();

    const { id } = await client.actions.create({
      entity: "post",
      input: { title: "T", body: "hello" },
      groups: ["g_1"],
    });

    const action = written[0]!;
    const docUpdate = action.updates.find((u) => u.subject_type === "article_body");
    expect(docUpdate).toBeDefined();
    expect(action.updates.some((u) => u.subject_type === "text_document")).toBe(false);

    const row = await client.post.get(id);
    expect((await row!.body)!.text).toBe("hello");
    expect(customSchema.entities.article_body).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Generated document entities / conflictScope
// ---------------------------------------------------------------------------

describe("generated document entities", () => {
  it("gives each derived field its own document entity and wire subject_type", async () => {
    const withTwo = defineEntity("article", {
      title: e.string(),
      body: e.collaborativeText(),
      subtitle: e.collaborativeText(),
    });
    const twoSchema = defineSchema({ entities: { article: withTwo }, version: 1 });
    const bodyDoc = generatedDocEntityName("article", "body");
    const subtitleDoc = generatedDocEntityName("article", "subtitle");

    expect(bodyDoc).not.toBe(subtitleDoc);
    expect(twoSchema.entities["text_document__article__body"]).toBeDefined();
    expect(twoSchema.entities["text_document__article__subtitle"]).toBeDefined();

    const { client, written } = harness(twoSchema);
    await client.handshake();
    await client.actions.create({
      entity: "article",
      input: { title: "T", body: "main", subtitle: "sub" },
      groups: ["g_1"],
    });

    const subjectTypes = written[0]!.updates.map((u) => u.subject_type);
    expect(subjectTypes).toContain(bodyDoc);
    expect(subjectTypes).toContain(subtitleDoc);
    expect(subjectTypes).not.toContain("text_document");
  });

  it("threads a declared conflictScope onto the generated document entity", () => {
    const scoped = defineEntity("page", {
      body: e.collaborativeText({ conflictScope: "entity" }),
    });
    const scopedSchema = defineSchema({ entities: { page: scoped }, version: 1 });
    const docName = generatedDocEntityName("page", "body");
    expect(scopedSchema.entities["text_document__page__body"].conflictScope).toBe("entity");
    expect(scopedSchema._registry.getConflictScope(docName)).toBe("entity");
  });

  it("defaults the generated document entity's scope to field", () => {
    const docName = generatedDocEntityName("blog_post", "body");
    expect(schema.entities["text_document__blog_post__body"].conflictScope).toBe("field");
    expect(schema._registry.getConflictScope(docName)).toBe("field");
  });

  it("materializes a generated document entity on demand", () => {
    expect(schema.entities["text_document__blog_post__body"].materialization).toBe("on-demand");
  });

  it("materializes a custom document entity on demand", () => {
    const custom = defineEntity("post", {
      body: e.collaborativeText({ entity: "article_body" }),
    });
    const customSchema = defineSchema({ entities: { post: custom }, version: 1 });
    expect(customSchema.entities.article_body.materialization).toBe("on-demand");
  });

  it("keeps the materialization of an explicitly declared document entity", () => {
    const declaredDoc = defineEntity(
      "article_body",
      { content: e.map(TextCellSchema) },
      { materialization: "held" },
    );
    const custom = defineEntity("post", {
      body: e.collaborativeText({ entity: "article_body" }),
    });
    const customSchema = defineSchema({
      entities: { post: custom, article_body: declaredDoc },
      version: 1,
    });
    expect(customSchema.entities.article_body.materialization).toBe("held");
  });

  it("inherits the parent entity's conflictScope when the field omits it", () => {
    const inherited = defineEntity(
      "note",
      { body: e.collaborativeText() },
      {
        conflictScope: "entity",
      },
    );
    const inheritedSchema = defineSchema({ entities: { note: inherited }, version: 1 });
    expect(inherited.conflictScope).toBe("entity");
    expect(inheritedSchema.entities["text_document__note__body"].conflictScope).toBe("entity");
    expect(inheritedSchema._registry.getConflictScope(generatedDocEntityName("note", "body"))).toBe(
      "entity",
    );
  });

  it("lets the field sugar override the parent entity's scope", () => {
    const overridden = defineEntity(
      "note",
      { body: e.collaborativeText({ conflictScope: "field" }) },
      { conflictScope: "entity" },
    );
    const overriddenSchema = defineSchema({ entities: { note: overridden }, version: 1 });
    expect(overriddenSchema.entities["text_document__note__body"].conflictScope).toBe("field");
  });

  it("defaults getConflictScope to field for an unknown entity", () => {
    expect(schema._registry.getConflictScope("never_declared")).toBe("field");
  });

  it("builds two derived fields with different scopes without error", () => {
    const mixed = defineEntity("mixed", {
      a: e.collaborativeText({ conflictScope: "entity" }),
      b: e.collaborativeText(),
    });
    const mixedSchema = defineSchema({ entities: { mixed }, version: 1 });
    expect(mixedSchema._registry.getConflictScope(generatedDocEntityName("mixed", "a"))).toBe(
      "entity",
    );
    expect(mixedSchema._registry.getConflictScope(generatedDocEntityName("mixed", "b"))).toBe(
      "field",
    );
  });

  it("rejects an explicit entity name carrying the reserved prefix", () => {
    const bad = defineEntity("bad", {
      body: e.collaborativeText({ entity: "text_document__x__y" }),
    });
    expect(() => defineSchema({ entities: { bad }, version: 1 })).toThrow(/reserved/);
  });

  it("rejects two generated names that alias under the reserved scheme", () => {
    const first = defineEntity("a__b", { c: e.collaborativeText() });
    const second = defineEntity("a", { b__c: e.collaborativeText() });
    expect(() => defineSchema({ entities: { first, second }, version: 1 })).toThrow(
      DerivedDocNameCollisionError,
    );
  });

  it("shares one explicit document entity when the scopes agree", async () => {
    const shared = defineEntity("note", {
      body: e.collaborativeText({ entity: "shared_body", conflictScope: "entity" }),
      subtitle: e.collaborativeText({ entity: "shared_body", conflictScope: "entity" }),
    });
    const sharedSchema = defineSchema({ entities: { note: shared }, version: 1 });
    expect(sharedSchema.entities.shared_body).toBeDefined();
    expect(sharedSchema._registry.getConflictScope("shared_body")).toBe("entity");

    const { client, written } = harness(sharedSchema);
    await client.handshake();
    await client.actions.create({
      entity: "note",
      input: { body: "main", subtitle: "sub" },
      groups: ["g_1"],
    });
    const docUpdates = written[0]!.updates.filter((u) => u.subject_type === "shared_body");
    expect(docUpdates).toHaveLength(2);
  });

  it("rejects explicit sharing when the scopes disagree", () => {
    const mismatch = defineEntity("note", {
      body: e.collaborativeText({ entity: "shared_body", conflictScope: "field" }),
      subtitle: e.collaborativeText({ entity: "shared_body", conflictScope: "entity" }),
    });
    expect(() => defineSchema({ entities: { note: mismatch }, version: 1 })).toThrow(
      ConflictScopeMismatchError,
    );
  });
});

// ---------------------------------------------------------------------------
// Local edits reach a peer
// ---------------------------------------------------------------------------

describe("local edits through the derived accessor", () => {
  it("self-flushes and converges on a second client", async () => {
    const { client: a, written } = harness(schema, "actor_a");
    const { client: b } = harness(schema, "actor_b");
    await a.handshake();
    await b.handshake();

    const { id } = await a.actions.create({
      entity: "blogPost",
      input: { title: "Hello", published: false, body: "world" },
      groups: ["g_1"],
    });

    // Seed the peer with the create Action.
    for (const action of written) await callApplyAction(b, action, "g_1");

    const doc = await (await a.blogPost.get(id))!.body;
    expect(doc!.text).toBe("world");

    const before = written.length;
    doc!.localInsert("!");
    await waitForFlush(() => doc!.pendingActions());
    expect(written.length).toBeGreaterThan(before);

    for (const action of written.slice(before)) {
      await callApplyAction(b, action, "g_1");
    }

    const peerDoc = await (await b.blogPost.get(id))!.body;
    expect(peerDoc!.text).toBe("world!");
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe("conflicts through client.conflicts", () => {
  it("does not surface a same-run extend-vs-delete as a slot", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "T", published: false, body: "hello" },
      groups: ["g_1"],
    });
    const createAction = written[0]!;
    await callApplyAction(client, { ...createAction, gsn: 1 }, "g_1");

    const doc = await (await client.blogPost.get(id))!.body;
    const runId = doc!.docState.index.spans[0]!.runId;
    const before = written.length;
    doc!.localExtend({ runId, appendText: "!" });
    await waitForFlush(() => doc!.pendingActions());
    expect(written.length).toBeGreaterThan(before);

    const docId = createAction.updates.find(
      (u) => u.subject_type === generatedDocEntityName("blog_post", "body"),
    )!.subject_id;
    const peerHlc = makeHlc(1_711_036_800_500);
    // A delete is a cut keyed by its own id; the extend is a new run keyed by
    // its own id. There is no shared position, so the race collapses.
    const peerAction: Action = {
      id: "act_peer_cut",
      actor_id: "actor_peer",
      hlc: peerHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_peer_cut",
          subject_id: docId,
          subject_type: generatedDocEntityName("blog_post", "body"),
          method: "patch",
          data: {
            fields: {
              content: {
                map: {
                  "peer-cut": {
                    value: {
                      kind: "cut",
                      id: "peer-cut",
                      runId,
                      from: 0,
                      to: 1,
                      author: "actor_peer",
                      stamp: peerHlc,
                    },
                    update_id: "upd_peer_cut",
                    hlc: peerHlc,
                  },
                },
              },
            },
          } as never,
        },
      ],
    };
    await callApplyAction(client, peerAction, "g_1");
    await client.outbox.detectConflicts([peerAction], "cu_1");

    expect(await client.conflicts.list()).toEqual([]);
  });

  it("does not surface a write to a different run", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "T", published: false, body: "hello" },
      groups: ["g_1"],
    });

    const doc = await (await client.blogPost.get(id))!.body;
    const runId = doc!.docState.index.spans[0]!.runId;
    doc!.localExtend({ runId, appendText: "!" });
    await waitForFlush(() => doc!.pendingActions());

    const docId = written[0]!.updates.find(
      (u) => u.subject_type === generatedDocEntityName("blog_post", "body"),
    )!.subject_id;
    const peerHlc = makeHlc(1_711_036_800_500);
    const peerAction: Action = {
      id: "act_peer_other",
      actor_id: "actor_peer",
      hlc: peerHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_peer_other",
          subject_id: docId,
          subject_type: generatedDocEntityName("blog_post", "body"),
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  "peer-run": {
                    value: {
                      kind: "run",
                      id: "peer-run",
                      text: "other",
                      author: "actor_peer",
                      stamp: peerHlc,
                      anchor: { runId: "ROOT", offset: 0 },
                    },
                    update_id: "upd_peer_other",
                    hlc: peerHlc,
                  },
                },
              },
            },
          } as never,
        },
      ],
    };
    await callApplyAction(client, peerAction, "g_1");
    await client.outbox.detectConflicts([peerAction], "cu_1");

    expect(await client.conflicts.list()).toEqual([]);
  });

  it("no longer surfaces the devlog Colour scenario", async () => {
    // #392 treated a same-run extend-vs-delete as one position. The rebuild
    // gives the extend its own run key and the delete its own cut key, so
    // there is no position to contest. This is the documented behaviour
    // change: text surfaces no slots at all.
    const { client, written } = harness(schema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "blogPost",
      input: { title: "Colour", published: false, body: "Red Magic" },
      groups: ["g_1"],
    });
    const createAction = written[0]!;
    await callApplyAction(client, { ...createAction, gsn: 1 }, "g_1");

    const doc = await (await client.blogPost.get(id))!.body;
    const runId = doc!.docState.index.spans[0]!.runId;
    doc!.localExtend({ runId, appendText: " Magic" });
    await waitForFlush(() => doc!.pendingActions());

    const docId = createAction.updates.find(
      (u) => u.subject_type === generatedDocEntityName("blog_post", "body"),
    )!.subject_id;
    const aliceHlc = makeHlc(1_711_036_800_600);
    const deleteAction: Action = {
      id: "act_alice_delete",
      actor_id: "actor_alice",
      hlc: aliceHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_alice",
          subject_id: docId,
          subject_type: generatedDocEntityName("blog_post", "body"),
          method: "patch",
          data: {
            fields: {
              content: {
                map: {
                  "alice-cut": {
                    value: {
                      kind: "cut",
                      id: "alice-cut",
                      runId,
                      from: 0,
                      to: 9,
                      author: "actor_alice",
                      stamp: aliceHlc,
                    },
                    update_id: "upd_alice",
                    hlc: aliceHlc,
                  },
                },
              },
            },
          } as never,
        },
      ],
    };
    await callApplyAction(client, deleteAction, "g_1");
    await client.outbox.detectConflicts([deleteAction], "cu_1");

    expect(await client.conflicts.list()).toEqual([]);
  });

  it("surfaces a different-run edit at entity scope, with no overlapping slots", async () => {
    const { client, written } = harness(entitySchema);
    await client.handshake();
    const { id } = await client.actions.create({
      entity: "entityPost",
      input: { title: "T", published: false, body: "hello" },
      groups: ["g_1"],
    });
    const createAction = written[0]!;
    await callApplyAction(client, { ...createAction, gsn: 1 }, "g_1");

    const doc = await (await client.entityPost.get(id))!.body;
    const runId = doc!.docState.index.spans[0]!.runId;
    doc!.localExtend({ runId, appendText: "!" });
    await waitForFlush(() => doc!.pendingActions());

    const docId = createAction.updates.find(
      (u) => u.subject_type === generatedDocEntityName("blog_post", "body"),
    )!.subject_id;
    const peerHlc = makeHlc(1_711_036_800_500);
    const peerAction: Action = {
      id: "act_peer_entity",
      actor_id: "actor_peer",
      hlc: peerHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_peer_entity",
          subject_id: docId,
          subject_type: generatedDocEntityName("blog_post", "body"),
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  "peer-run": {
                    value: {
                      kind: "run",
                      id: "peer-run",
                      text: "other",
                      author: "actor_peer",
                      stamp: peerHlc,
                      anchor: { runId: "ROOT", offset: 0 },
                    },
                    update_id: "upd_peer_entity",
                    hlc: peerHlc,
                  },
                },
              },
            },
          } as never,
        },
      ],
    };
    await callApplyAction(client, peerAction, "g_1");
    await client.outbox.detectConflicts([peerAction], "cu_1");

    const conflicts = await client.conflicts.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.subjects).toEqual([docId]);
    // Entity scope: surfaced even though no position overlapped, with no
    // slot list to misread as a position-level verdict.
    expect(conflicts[0]!.scope).toBe("entity");
    expect(conflicts[0]!.entries[0]!.slots).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Write discipline
// ---------------------------------------------------------------------------

describe("the client write path is append-only for a text body", () => {
  const docType = generatedDocEntityName("blog_post", "body");

  const patchAction = (
    docId: string,
    cells: Record<string, unknown>,
    updateId: string,
    hlc: string,
  ): Action => ({
    id: `act_${updateId}`,
    actor_id: "actor_1",
    hlc,
    gsn: 0,
    updates: [
      {
        id: updateId,
        subject_id: docId,
        subject_type: docType,
        method: "patch",
        data: {
          fields: {
            content: { map: cells },
            version: { value: 1, update_id: updateId, hlc },
          },
        } as never,
      },
    ],
  });

  it("refuses a rewrite of an existing cell and permits a new one", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    await client.actions.create({
      entity: "blogPost",
      input: { title: "T", published: false, body: "hello" },
      groups: ["g_1"],
    });
    const createAction = written[0]!;
    await callApplyAction(client, createAction, "g_1");

    const docUpdate = createAction.updates.find((u) => u.subject_type === docType)!;
    const docId = docUpdate.subject_id;
    const content = (
      docUpdate.data as unknown as {
        fields: {
          content: {
            map: Record<string, { value: { id: string }; update_id: string; hlc: string }>;
          };
        };
      }
    ).fields.content;
    const [cellId, entry] = Object.entries(content.map)[0]!;
    const rewriteHlc = (BigInt(entry.hlc) + 1_000n).toString();

    const rewrite = patchAction(
      docId,
      {
        [cellId]: {
          ...entry,
          value: { ...entry.value, text: "rewritten" },
          update_id: "u_rewrite",
          hlc: rewriteHlc,
        },
      },
      "u_rewrite",
      rewriteHlc,
    );

    const submittedBefore = written.length;
    await expect(client.write([rewrite])).rejects.toBeInstanceOf(AppendOnlyViolationError);
    expect(written.length).toBe(submittedBefore);

    // A new cell key is exactly what every real edit writes: accepted.
    const newHlc = (BigInt(rewriteHlc) + 1_000n).toString();
    const added = patchAction(
      docId,
      {
        [`${newHlc}:actor_1`]: {
          value: {
            kind: "run",
            id: `${newHlc}:actor_1`,
            text: "!",
            author: "actor_1",
            stamp: newHlc,
            anchor: { runId: cellId, offset: 5 },
          },
          update_id: "u_add",
          hlc: newHlc,
        },
      },
      "u_add",
      newHlc,
    );
    await expect(client.write([added])).resolves.toEqual({ rejected: [] });
    expect(written.length).toBeGreaterThan(submittedBefore);
  });
});

// ---------------------------------------------------------------------------
// Type surface
// ---------------------------------------------------------------------------

describe("type surface", () => {
  it("keeps the body out of the query filter", () => {
    const { client } = harness(schema);
    // @ts-expect-error `body` is derived, not a wire field, so it is not subscribable.
    client.blogPost.subscribe({ body: "x" }, () => {});
  });
});
