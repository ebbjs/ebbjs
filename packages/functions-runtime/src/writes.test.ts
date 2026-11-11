/**
 * The write verbs: each buffers the Updates the client planner would build,
 * runs its validation at the call, and leaves exactly one commit frame behind
 * regardless of how many verbs ran.
 */

import { describe, expect, it } from "vitest";

import {
  ActionRejectedError,
  EntityValidationError,
  HostCallError,
  MissingSchemaError,
  WritesCommittedError,
  actionIdForInvocation,
  createContext,
} from "./index.ts";
import {
  countingIds,
  fakeHost,
  hostRow,
  modelsOf,
  rowsOf,
  testContext,
  valueOf,
} from "./test-support/host.ts";

const ISSUE = { title: "Ship", done: false, labels: [] };

describe("ctx.create", () => {
  it("buffers the entity put and its membership rows and returns a handle", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    const handle = ctx.create("issue", ISSUE, { id: "e_issue1", groups: ["g_1"] });

    expect(handle).toEqual({ id: "e_issue1" });
    expect(Object.isFrozen(handle)).toBe(true);

    await ctx.commit();
    const [action] = host.commits as { updates: Parameters<typeof modelsOf>[0] }[];

    const models = modelsOf(action!.updates).filter(
      (model, index, all) => model !== all[index - 1],
    );
    expect(models).toEqual(["issue", "entityGroup"]);
    expect(action!.updates.every((update) => update.method === "replace")).toBe(true);
  });

  it("collapses a handle used as a later field value or relationship pointer", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    const project = ctx.create("project", { name: "Roadmap" }, { id: "e_proj1", groups: ["g_1"] });
    ctx.create("project", { name: project }, { id: "e_proj2", groups: ["g_1"] });
    ctx.create("issue", { ...ISSUE, project }, { id: "e_issue1", groups: ["g_1"] });
    await ctx.commit();

    const [action] = host.commits as { updates: Parameters<typeof modelsOf>[0] }[];
    const [copiedRow] = rowsOf(action!.updates, "project").filter(
      (row) => row[0]!.subject_id === "e_proj2",
    );
    const [relationship] = rowsOf(action!.updates, "relationship");

    expect(valueOf(copiedRow!, "name")).toBe(project.id);
    expect(valueOf(relationship!, "target_id")).toBe(project.id);
    expect(valueOf(relationship!, "field")).toBe("project");
  });

  it("requires a non-empty groups option", () => {
    const ctx = testContext(fakeHost());

    expect(() => ctx.create("issue", ISSUE, { groups: [] })).toThrow(EntityValidationError);
    expect(() => ctx.create("issue", ISSUE, {} as never)).toThrow(/is required/);
  });

  it("refuses an invalid field at the call and buffers nothing", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    expect(() => ctx.create("issue", { nope: 1 }, { id: "e_x", groups: ["g_1"] })).toThrow(
      EntityValidationError,
    );

    await expect(ctx.commit()).resolves.toEqual({ replayed: false });
    expect(host.commits).toEqual([]);
  });

  it("refuses an entity the schema does not register", () => {
    const ctx = testContext(fakeHost());

    expect(() => ctx.create("unregistered", ISSUE, { groups: ["g_1"] })).toThrow(
      /is not registered in the schema/,
    );
  });

  it("fails with a clear error when no schema was supplied", async () => {
    const host = fakeHost();
    const ctx = createContext({
      transport: host.transport,
      invocationId: "inv_test",
      actor: { id: "a_test" },
      caller: { kind: "actor", id: "a_test" },
    });

    expect(() => ctx.create("issue", ISSUE, { groups: ["g_1"] })).toThrow(MissingSchemaError);
  });
});

describe("ctx.update / ctx.delete", () => {
  it("buffers a patch and a delete in call order", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "Revised" });
    ctx.delete("issue", "e_issue2");
    await ctx.commit();

    const [action] = host.commits as { updates: { subject_id: string; method: string }[] }[];
    expect(action?.updates).toMatchObject([
      { subject_id: "e_issue1", method: "merge" },
      { subject_id: "e_issue2", method: "delete", data: null },
    ]);
  });

  it("refuses an empty patch", () => {
    const ctx = testContext(fakeHost());
    expect(() => ctx.update("issue", "e_issue1", {})).toThrow(EntityValidationError);
  });
});

describe("ctx.relate / ctx.unrelate", () => {
  it("links a one-cardinality relationship and unlinks it by the row id it minted", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.relate("issue", "e_issue1", "project", "e_proj1");
    await ctx.unrelate("issue", "e_issue1", "project");
    await ctx.commit();

    const [action] = host.commits as { updates: Parameters<typeof modelsOf>[0] }[];
    const relationshipRows = rowsOf(action!.updates, "relationship");
    const deleted = action!.updates.filter((update) => update.method === "delete");

    // One rel_seeded row (four components) and its delete.
    expect(relationshipRows).toHaveLength(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.subject_id).toBe(relationshipRows[0]![0]!.subject_id);
  });

  it("sets a many-cardinality FK list and clears it", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.relate("issue", "e_issue1", "labels", ["e_l1", "e_l2"]);
    await ctx.unrelate("issue", "e_issue1", "labels");
    await ctx.commit();

    const [action] = host.commits as { updates: Parameters<typeof modelsOf>[0] }[];
    const labels = action!.updates
      .filter((update) => update.method !== "delete" && update.component === "issue/labels")
      .map((update) => (update.data as { value: unknown }).value);

    expect(labels).toEqual([["e_l1", "e_l2"], []]);
  });

  it("drops one target from the current FK set read through the overlay", async () => {
    const host = fakeHost({
      e_issue1: hostRow("e_issue1", "issue", { labels: ["e_l1", "e_l2"] }),
    });
    const ctx = testContext(host);

    await ctx.unrelate("issue", "e_issue1", "labels", "e_l1");
    await ctx.commit();

    const [action] = host.commits as { updates: Parameters<typeof modelsOf>[0] }[];
    const labels = action!.updates.find(
      (update) => update.method !== "delete" && update.component === "issue/labels",
    )!;
    expect(labels.data).toMatchObject({ value: ["e_l2"] });
  });

  it("refuses to unlink one target of an FK set it cannot read", async () => {
    const ctx = testContext(fakeHost());

    await expect(ctx.unrelate("issue", "e_issue1", "labels", "e_l1")).rejects.toThrow(
      EntityValidationError,
    );
  });

  it("refuses a one-cardinality unlink whose row id it cannot see", async () => {
    const ctx = testContext(fakeHost());

    await expect(ctx.unrelate("issue", "e_issue1", "project")).rejects.toThrow(/relationshipId/);
  });

  it("deletes a stored one-cardinality edge when the caller names its row id", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    await ctx.unrelate("issue", "e_issue1", "project", undefined, { relationshipId: "rel_known" });
    await ctx.commit();

    const [action] = host.commits as { updates: unknown[] }[];
    expect(action?.updates).toMatchObject([
      { subject_id: "rel_known", method: "delete", data: null },
    ]);
  });

  it("refuses an undeclared relationship and the built-in membership accessor", () => {
    const ctx = testContext(fakeHost());

    expect(() => ctx.relate("issue", "e_issue1", "bogus", "e_x")).toThrow(EntityValidationError);
    expect(() => ctx.relate("issue", "e_issue1", "groups", "g_1")).toThrow(/built-in/);
  });
});

describe("ctx.commit", () => {
  it("sends one core Action with the derived id, the actor, and gsn 0", async () => {
    const host = fakeHost();
    const ctx = testContext(host, { ids: countingIds() });

    ctx.update("issue", "e_issue1", { title: "a" });
    ctx.update("issue", "e_issue1", { title: "b" });
    ctx.update("issue", "e_issue1", { title: "c" });
    const outcome = await ctx.commit();

    expect(outcome).toEqual({ replayed: false });
    expect(host.commits).toHaveLength(1);
    expect(host.commits[0]).toMatchObject({
      id: actionIdForInvocation("inv_test"),
      actor_id: "a_test",
      gsn: 0,
    });
    expect((host.commits[0] as { updates: unknown[] }).updates).toHaveLength(3);
  });

  it("is a no-op when nothing is buffered and never sends a second frame", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    await expect(ctx.commit()).resolves.toEqual({ replayed: false });
    expect(host.commits).toEqual([]);

    ctx.update("issue", "e_issue1", { title: "once" });
    await ctx.commit();
    await expect(ctx.commit()).resolves.toEqual({ replayed: false });
    expect(host.commits).toHaveLength(1);
  });

  it("seals the buffer after a commit", async () => {
    const ctx = testContext(fakeHost());
    ctx.update("issue", "e_issue1", { title: "only" });
    await ctx.commit();

    expect(() => ctx.update("issue", "e_issue1", { title: "too late" })).toThrow(
      WritesCommittedError,
    );
    expect(() => ctx.create("issue", ISSUE, { groups: ["g_1"] })).toThrow(WritesCommittedError);
    expect(() => ctx.relate("issue", "e_issue1", "project", "e_p1")).toThrow(WritesCommittedError);
  });

  it("refuses an Action naming a subject type the schema does not know", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.update("unregistered", "e_x", { title: "x" });
    await expect(ctx.commit()).rejects.toThrow(EntityValidationError);
    expect(host.commits).toEqual([]);
  });

  it("reports a replay", async () => {
    const host = fakeHost();
    host.reply = { replayed: true };
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "retry" });
    await expect(ctx.commit()).resolves.toEqual({ replayed: true });
  });

  it("rejects with the server's rejection list", async () => {
    const host = fakeHost();
    host.error = {
      error: "rejected",
      status: 422,
      details: "last_membership",
      rejected: [{ id: "eg_1", reason: "last_membership", details: "no group left" }],
    };
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "nope" });
    const error = await ctx.commit().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionRejectedError);
    expect((error as ActionRejectedError).rejections).toEqual([
      { id: "eg_1", reason: "last_membership", details: "no group left" },
    ]);
  });

  it("rejects with a host error for anything else", async () => {
    const host = fakeHost();
    host.error = { error: "internal", status: 500, details: "writer unavailable" };
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "nope" });
    const error = await ctx.commit().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostCallError);
    expect(error).toMatchObject({ code: "internal", status: 500, details: "writer unavailable" });
  });

  it("propagates a transport failure unchanged", async () => {
    const host = fakeHost();
    host.error = new Error("host socket closed");
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "nope" });
    await expect(ctx.commit()).rejects.toThrow("host socket closed");
  });
});
