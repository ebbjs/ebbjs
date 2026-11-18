/**
 * The write verbs: each buffers the Updates the client planner would build,
 * runs its validation at the call, and leaves exactly one commit frame behind
 * regardless of how many verbs ran.
 */

import { isComponentUpdate, isFieldMap, isRowCreate, type Update } from "@ebbjs/core";
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

/** Every `ebb/link` key a batch writes, flattening the three key levels. */
const linkLeaves = (
  updates: readonly Update[],
): Array<{ as: string; type: string; targetId: string; value: unknown }> => {
  const leaves: Array<{ as: string; type: string; targetId: string; value: unknown }> = [];
  for (const update of updates) {
    if (!isComponentUpdate(update) || update.component !== "ebb/link") continue;
    if (update.method === "drop" || !isFieldMap(update.data)) continue;
    for (const [as, byType] of Object.entries(update.data.map)) {
      if (!isFieldMap(byType)) continue;
      for (const [type, byTarget] of Object.entries(byType.map)) {
        if (!isFieldMap(byTarget)) continue;
        for (const [targetId, leaf] of Object.entries(byTarget.map)) {
          leaves.push({ as, type, targetId, value: isFieldMap(leaf) ? undefined : leaf.value });
        }
      }
    }
  }
  return leaves;
};

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
    expect(models).toEqual(["issue", "ebb"]);
    // Every row is born in a create that comes before its own component writes.
    expect(
      action!.updates.filter(isRowCreate).map((create) => [create.subject_id, create.model]),
    ).toEqual([
      ["e_issue1", "issue"],
      ["eg_8_e_issue1g_1", "ebb"],
    ]);
    // The row's create, its two leaves, the membership row's create and
    // component; `labels` is an accessor, so an empty set writes no edge.
    expect(action!.updates.map((update) => update.method)).toEqual([
      "create",
      "replace",
      "replace",
      "create",
      "replace",
    ]);
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
    const links = action!.updates.filter(
      (update) => isComponentUpdate(update) && update.component === "ebb/link",
    );

    expect(valueOf(copiedRow!, "name")).toBe(project.id);
    // The edge is a key on its source row, not a row of its own.
    expect(links.every((link) => link.subject_id === "e_issue1")).toBe(true);
    expect(linkLeaves(links)).toEqual([
      { as: "project", type: "issue", targetId: project.id, value: true },
    ]);
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
  it("links a one-cardinality edge on its source, then clears it through the overlay", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.relate("issue", "e_issue1", "project", "e_proj1");
    await ctx.unrelate("issue", "e_issue1", "project");
    await ctx.commit();

    const [action] = host.commits as { updates: Update[] }[];

    // Two Updates on the source — the presence, then the tombstone — and no
    // edge row anywhere.
    expect(action!.updates).toHaveLength(2);
    expect(action!.updates.every((update) => update.subject_id === "e_issue1")).toBe(true);
    expect(linkLeaves(action!.updates)).toEqual([
      { as: "project", type: "issue", targetId: "e_proj1", value: true },
      { as: "project", type: "issue", targetId: "e_proj1", value: null },
    ]);
  });

  it("sets a many-cardinality target list and clears it", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    ctx.relate("issue", "e_issue1", "labels", ["e_l1", "e_l2"]);
    await ctx.unrelate("issue", "e_issue1", "labels");
    await ctx.commit();

    const [action] = host.commits as { updates: Update[] }[];
    expect(linkLeaves(action!.updates)).toEqual([
      { as: "labels", type: "issue", targetId: "e_l1", value: true },
      { as: "labels", type: "issue", targetId: "e_l2", value: true },
      { as: "labels", type: "issue", targetId: "e_l1", value: null },
      { as: "labels", type: "issue", targetId: "e_l2", value: null },
    ]);
  });

  it("adds a many-cardinality set even when the source row's edges are readable", async () => {
    const host = fakeHost({
      e_issue1: hostRow("e_issue1", "issue", {
        link: { labels: { issue: { e_l1: true, e_l2: true } } },
      }),
    });
    const ctx = testContext(host);

    ctx.relate("issue", "e_issue1", "labels", ["e_l3"]);
    await ctx.commit();

    const [action] = host.commits as { updates: Update[] }[];
    // This surface's `relate` is an add: it gives presence to the targets it
    // names and tombstones no edge, readable row or not.
    expect(linkLeaves(action!.updates)).toEqual([
      { as: "labels", type: "issue", targetId: "e_l3", value: true },
    ]);
    expect(host.calls.filter((call) => call.op === "get")).toHaveLength(0);
  });

  it("tombstones a named target without reading the row", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    await ctx.unrelate("issue", "e_issue1", "labels", "e_l1");
    await ctx.commit();

    const [action] = host.commits as { updates: Update[] }[];
    expect(linkLeaves(action!.updates)).toEqual([
      { as: "labels", type: "issue", targetId: "e_l1", value: null },
    ]);
    expect(host.calls.filter((call) => call.op === "get")).toHaveLength(0);
  });

  it("clears a stored edge it reads through ctx.get", async () => {
    const host = fakeHost({
      e_issue1: hostRow("e_issue1", "issue", {
        link: { project: { issue: { e_proj1: true } } },
      }),
    });
    const ctx = testContext(host);

    await ctx.unrelate("issue", "e_issue1", "project");
    await ctx.commit();

    const [action] = host.commits as { updates: Update[] }[];
    expect(linkLeaves(action!.updates)).toEqual([
      { as: "project", type: "issue", targetId: "e_proj1", value: null },
    ]);
  });

  it("refuses to clear an accessor whose row it cannot read", async () => {
    const ctx = testContext(fakeHost());

    await expect(ctx.unrelate("issue", "e_issue1", "project")).rejects.toThrow(
      /cannot read the live "project" edges/,
    );
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
