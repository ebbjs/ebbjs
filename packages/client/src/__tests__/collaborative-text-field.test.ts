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
import { decodeSync, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { TSchema } from "@sinclair/typebox/type";

import { e, defineEntity, type EntityDef } from "../schema/entity";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import { defineRelationship, type RelationshipDef } from "../schema/relationship";
import { defineSchema, type Schema } from "../schema/schema";
import { createClient, type NamespacedClient } from "../sync/client";
import { callApplyAction, jsonResponse } from "../sync/test-utils";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HANDSHAKE = {
  actor_id: "actor_1",
  groups: [
    {
      id: "g_1",
      permissions: [
        "blog_post.*",
        "text_document.*",
        "article.*",
        "post.*",
        "article_body.*",
        "relationship.*",
        "entityGroup.*",
      ],
      cursor_valid: true,
      reason: null,
      cursor: 0,
    },
  ],
};

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

function harness<S extends AnySchema>(
  activeSchema: S,
  actorId = "actor_1",
): { client: NamespacedClient<S>; written: Action[] } {
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
    fetchImpl,
  });
  return { client, written };
}

const waitForFlush = async (pending: () => readonly Action[]): Promise<void> => {
  for (let i = 0; i < 50 && pending().length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

describe("e.collaborativeText() schema sugar", () => {
  it("hoists the declared body out of the parent's wire shape", () => {
    expect(Object.keys(blogPost.shape.properties)).toEqual(["title", "published"]);
    expect(Object.keys(blogPost.fields)).toEqual(["title", "published"]);
    expect(blogPost.derived).toEqual({
      body: { kind: "collaborative-text", entity: undefined },
    });
  });

  it("expands into a document entity and a collaborative-text relationship", () => {
    expect(schema.entities.text_document).toBeDefined();
    expect(Object.keys(schema.entities)).toContain("blogPost");
    const rel = schema._registry.getRelationship("blog_post", "body");
    expect(rel).toBeDefined();
    expect(rel!.target.name).toBe("text_document");
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

    const { id, rejected } = await client.blogPost.create(
      { title: "Hello", published: false, body: "world" },
      { groups: ["g_1"] },
    );

    expect(rejected).toEqual([]);
    expect(id).toMatch(/^e_/);
    expect(written).toHaveLength(1);

    const updates = written[0]!.updates;
    const byType = (type: string): typeof updates => updates.filter((u) => u.subject_type === type);

    expect(byType("blog_post")).toHaveLength(1);
    expect(byType("text_document")).toHaveLength(1);
    expect(byType("relationship")).toHaveLength(1);
    expect(byType("entityGroup")).toHaveLength(2);

    const docUpdate = byType("text_document")[0]!;
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
    const { id } = await client.blogPost.create(
      { title: "No body", published: false },
      { groups: ["g_1"] },
    );
    const row = await client.blogPost.get(id);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("No body");
    expect(await row!.body).toBeNull();
  });

  it("refuses a non-string derived body", async () => {
    const { client } = harness(schema);
    await client.handshake();
    await expect(
      client.blogPost.create({ title: "T", published: false, body: 42 } as never, {
        groups: ["g_1"],
      }),
    ).rejects.toBeInstanceOf(EntityValidationError);
  });
});

describe("atomic", () => {
  it("refuses a derived body with a clear error instead of resolving it as a pointer", async () => {
    const { client } = harness(schema);
    await client.handshake();
    await expect(
      client.atomic(({ blogPost }) =>
        blogPost.create({ title: "T", body: "x" }, { groups: ["g_1"] }),
      ),
    ).rejects.toThrow(/derived field/);
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("row.<body> hydration", () => {
  it("resolves a hydrated TextDocument with the created text", async () => {
    const { client } = harness(schema);
    await client.handshake();
    const { id } = await client.blogPost.create(
      { title: "Hello", published: false, body: "world" },
      { groups: ["g_1"] },
    );

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
    await client.blogPost.create(
      { title: "A", published: false, body: "one" },
      { groups: ["g_1"] },
    );
    await client.blogPost.create(
      { title: "B", published: false, body: "two" },
      { groups: ["g_1"] },
    );

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

    const { id } = await client.article.create(
      { title: "T", body: "main", subtitle: "sub" },
      { groups: ["g_1"] },
    );
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

    const { id } = await client.post.create({ title: "T", body: "hello" }, { groups: ["g_1"] });

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
// Local edits reach a peer
// ---------------------------------------------------------------------------

describe("local edits through the derived accessor", () => {
  it("self-flushes and converges on a second client", async () => {
    const { client: a, written } = harness(schema, "actor_a");
    const { client: b } = harness(schema, "actor_b");
    await a.handshake();
    await b.handshake();

    const { id } = await a.blogPost.create(
      { title: "Hello", published: false, body: "world" },
      { groups: ["g_1"] },
    );

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
  it("surfaces a same-run race after the local edit has been flushed", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    const { id } = await client.blogPost.create(
      { title: "T", published: false, body: "hello" },
      { groups: ["g_1"] },
    );
    const createAction = written[0]!;
    // Simulate the create Action's echo so it leaves the outbox; only
    // the extend should be a buffered loss.
    await callApplyAction(client, { ...createAction, gsn: 1 }, "g_1");

    const doc = await (await client.blogPost.get(id))!.body;
    const runId = [...doc!.docState.nodes.keys()].find((key) => key !== "ROOT")!;
    const before = written.length;
    doc!.localExtend({ runId, appendText: "!" });
    await waitForFlush(() => doc!.pendingActions());
    // The derived accessor self-flushes, so the local edit is
    // acknowledged by the time the peer write lands; the conflict sweep
    // must still surface the loss.
    expect(written.length).toBeGreaterThan(before);

    const docId = createAction.updates.find((u) => u.subject_type === "text_document")!.subject_id;
    const node = doc!.docState.nodes.get(runId)!;
    const peerHlc = String(BigInt(node.hlc) + 60_000n);
    const peerAction: Action = {
      id: "act_peer",
      actor_id: "actor_peer",
      hlc: peerHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_peer",
          subject_id: docId,
          subject_type: "text_document",
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  [runId]: {
                    value: { ...node, text: "hello!", hlc: peerHlc, actorId: "actor_peer" },
                    update_id: "upd_peer",
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

    const conflicts = await client.conflicts.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.losses[0]!.slot).toEqual({
      subjectId: docId,
      field: "content",
      path: [runId],
    });
  });

  it("does not surface a write to a different run", async () => {
    const { client, written } = harness(schema);
    await client.handshake();
    const { id } = await client.blogPost.create(
      { title: "T", published: false, body: "hello" },
      { groups: ["g_1"] },
    );

    const doc = await (await client.blogPost.get(id))!.body;
    const runId = [...doc!.docState.nodes.keys()].find((key) => key !== "ROOT")!;
    doc!.localExtend({ runId, appendText: "!" });
    await waitForFlush(() => doc!.pendingActions());

    const docId = written[0]!.updates.find((u) => u.subject_type === "text_document")!.subject_id;
    const node = doc!.docState.nodes.get(runId)!;
    const peerHlc = String(BigInt(node.hlc) + 60_000n);
    const peerAction: Action = {
      id: "act_peer_other",
      actor_id: "actor_peer",
      hlc: peerHlc,
      gsn: 9,
      updates: [
        {
          id: "upd_peer_other",
          subject_id: docId,
          subject_type: "text_document",
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  "peer-run": {
                    value: {
                      id: "peer-run",
                      hlc: peerHlc,
                      actorId: "actor_peer",
                      text: "other",
                      parentId: "ROOT",
                      deleted: false,
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

    expect(await client.conflicts.list()).toEqual([]);
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
