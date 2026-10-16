/**
 * Unit tests for the `changeGroups` operation — the pure membership
 * delta both the imperative verbs and the atomic drafts build.
 */

import { describe, expect, it } from "vitest";

import { EntityRegistry } from "../../schema/entity-registry";
import type { GeneratedParts } from "../generated-parts";
import { AtomicActionError, call, changeGroups, type OpContext } from "../operations";
import { commit, type CommitCapability } from "../committer";

const mkCtx = (): OpContext => ({
  registry: new EntityRegistry(),
  ids: {
    entityId: () => "e_1",
    updateId: () => "u_1",
    hlc: () => "hlc_1",
  },
  actorId: "actor_1",
});

const generatedParts: GeneratedParts = {
  documents: [
    {
      id: "doc_1",
      type: "text_document__blog_post__body",
      memberships: [{ membershipId: "eg_doc_1", groupId: "g_1" }],
    },
  ],
  edges: [
    {
      relationshipId: "rel_body",
      sourceId: "post_1",
      targetId: "doc_1",
      field: "body",
      type: "blog_post",
    },
  ],
};

describe("changeGroups", () => {
  it("emits an entityGroup put per added group then a delete per removed row", () => {
    const result = changeGroups(mkCtx(), {
      entity: "todo",
      entityId: "todo_1",
      puts: ["g_2"],
      removes: [{ membershipId: "eg_1", groupId: "g_1" }],
      currentGroups: ["g_1"],
    });

    expect(result.updates.map((update) => update.method)).toEqual(["put", "delete"]);
    expect(result.updates[0]!.subject_type).toBe("entityGroup");
    expect(result.updates[0]!.data?.fields?.["group_id"]?.value).toBe("g_2");
    expect(result.updates[1]!.subject_id).toBe("eg_1");
    expect(result.groups).toEqual(["g_1", "g_2"]);
    expect(result.subject).toEqual({ id: "todo_1", type: "todo" });
  });

  it("refuses a delta that would leave the entity with no owning group", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "g_1" }],
        currentGroups: ["g_1"],
      }),
    ).toThrowError(AtomicActionError);
  });

  it("refuses a membership write whose fan-out scope cannot be resolved", () => {
    expect(() =>
      changeGroups(mkCtx(), {
        entity: "todo",
        entityId: "todo_1",
        removes: [{ membershipId: "eg_1", groupId: "" }],
      }),
    ).toThrowError(AtomicActionError);
  });

  it("carries a generated document and re-emits its edge on an add", () => {
    const result = changeGroups(mkCtx(), {
      entity: "blog_post",
      entityId: "post_1",
      puts: ["g_2"],
      removes: [{ membershipId: "eg_post_1", groupId: "g_1" }],
      currentGroups: ["g_1"],
      generated: generatedParts,
    });

    expect(result.updates.map((update) => update.method)).toEqual([
      "put",
      "put",
      "put",
      "delete",
      "delete",
    ]);

    // Parent membership put.
    expect(result.updates[0]!.subject_type).toBe("entityGroup");
    expect(result.updates[0]!.data?.fields?.["entity_id"]?.value).toBe("post_1");
    expect(result.updates[0]!.data?.fields?.["group_id"]?.value).toBe("g_2");

    // Generated document membership put.
    expect(result.updates[1]!.subject_type).toBe("entityGroup");
    expect(result.updates[1]!.data?.fields?.["entity_id"]?.value).toBe("doc_1");
    expect(result.updates[1]!.data?.fields?.["group_id"]?.value).toBe("g_2");

    // Re-emitted edge, addressed by the existing relationship id.
    const edge = result.updates[2]!;
    expect(edge.subject_type).toBe("relationship");
    expect(edge.subject_id).toBe("rel_body");
    expect(edge.data?.fields?.["source_id"]?.value).toBe("post_1");
    expect(edge.data?.fields?.["target_id"]?.value).toBe("doc_1");
    expect(edge.data?.fields?.["field"]?.value).toBe("body");
    expect(edge.data?.fields?.["type"]?.value).toBe("blog_post");

    // Parent membership delete, then the document's.
    expect(result.updates[3]!.subject_id).toBe("eg_post_1");
    expect(result.updates[3]!.subject_type).toBe("entityGroup");
    expect(result.updates[4]!.subject_id).toBe("eg_doc_1");
    expect(result.updates[4]!.subject_type).toBe("entityGroup");
  });

  it("skips a generated document membership the document already holds", () => {
    const result = changeGroups(mkCtx(), {
      entity: "blog_post",
      entityId: "post_1",
      puts: ["g_2"],
      currentGroups: ["g_1"],
      generated: {
        documents: [
          {
            id: "doc_1",
            type: "text_document__blog_post__body",
            memberships: [{ membershipId: "eg_doc_2", groupId: "g_2" }],
          },
        ],
        edges: [],
      },
    });

    // Only the parent's put; the document is already in g_2.
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.data?.fields?.["entity_id"]?.value).toBe("post_1");
  });

  it("does not re-emit a generated edge when no group is added", () => {
    const result = changeGroups(mkCtx(), {
      entity: "blog_post",
      entityId: "post_1",
      removes: [{ membershipId: "eg_post_1", groupId: "g_1" }],
      currentGroups: ["g_1", "g_2"],
      generated: generatedParts,
    });

    expect(result.updates.map((update) => update.method)).toEqual(["delete", "delete"]);
    expect(result.updates[0]!.subject_id).toBe("eg_post_1");
    expect(result.updates[1]!.subject_id).toBe("eg_doc_1");
  });

  it("leaves the shape of a delta with no generated parts unchanged", () => {
    const result = changeGroups(mkCtx(), {
      entity: "todo",
      entityId: "todo_1",
      puts: ["g_2"],
      removes: [{ membershipId: "eg_1", groupId: "g_1" }],
      currentGroups: ["g_1"],
    });

    expect(result.updates.map((update) => update.method)).toEqual(["put", "delete"]);
  });

  it("commits a membership span through the committer", async () => {
    const submitted: unknown[] = [];
    const cap: CommitCapability = {
      registry: new EntityRegistry(),
      submitRelationshipUpdates: async (updates) => {
        submitted.push(updates);
        return { rejected: [] };
      },
      freshHlc: () => "hlc_1",
      generateUpdateId: () => "u_1",
      actorId: "actor_1",
    };

    const { groups } = await commit(
      [
        call(changeGroups, {
          entity: "todo",
          entityId: "todo_1",
          puts: ["g_2"],
          currentGroups: ["g_1"],
        }),
      ],
      cap,
    );

    expect(submitted).toHaveLength(1);
    expect(groups).toEqual(["g_2"]);
  });
});
