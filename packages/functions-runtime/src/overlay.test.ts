/**
 * Read-your-writes: `ctx.get` applies the invocation's buffered Updates over
 * the host's view with the wire's merge rule, so a handler reads what its
 * Action will store.
 */

import { describe, expect, it } from "vitest";

import { hostRow, fakeHost, projectFields, testContext } from "./test-support/host.ts";

const stored = (): ReturnType<typeof hostRow> =>
  hostRow("e_issue1", "issue", { title: "Stored", done: false, labels: [] });

describe("ctx.get overlay", () => {
  it("passes an untouched id through as the host's own object", async () => {
    const row = stored();
    const host = fakeHost({ e_issue1: row });
    const ctx = testContext(host);

    await expect(ctx.get("e_issue1")).resolves.toBe(row);
    expect(host.calls).toEqual([{ op: "get", payload: { id: "e_issue1" } }]);
  });

  it("shows a row created in this invocation with last_gsn 0 and the write's HLCs", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    const created = ctx.create(
      "issue",
      { title: "New", done: false, labels: [] },
      { id: "e_new", groups: ["g_1"] },
    );
    const view = await ctx.get(created.id);

    expect(view).toMatchObject({ id: "e_new", type: "issue", last_gsn: 0, deleted_hlc: null });
    expect(projectFields(view?.data.fields ?? {})).toEqual({
      title: "New",
      done: false,
      labels: [],
    });
    expect(view?.data.fields["title"]).toEqual({
      value: "New",
      update_id: expect.any(String),
      hlc: view?.created_hlc,
    });
    expect(view?.created_hlc).toMatch(/^\d+$/);
    expect(view?.updated_hlc).toBe(view?.created_hlc);
    // The write is the only source: no host read was needed.
    expect(host.calls).toEqual([]);
  });

  it("merges a buffered patch over the host's view", async () => {
    const host = fakeHost({ e_issue1: stored() });
    const ctx = testContext(host);

    ctx.update("issue", "e_issue1", { title: "Patched" });
    const view = await ctx.get("e_issue1");

    expect(projectFields(view?.data.fields ?? {})).toEqual({
      title: "Patched",
      done: false,
      labels: [],
    });
    // The patched field is the write's leaf; the untouched siblings keep the
    // host's stamps instead of being rewritten.
    expect(view?.data.fields["title"]).toMatchObject({ value: "Patched" });
    expect(view?.data.fields["done"]).toEqual({
      value: false,
      update_id: "u_host",
      hlc: "111690000000000000",
    });
    expect(view?.last_gsn).toBe(7);
    expect(view?.created_hlc).toBe("111690000000000000");
    expect(view?.updated_hlc).not.toBe("111690000000000000");
  });

  it("keeps every buffered patch in call order", async () => {
    const ctx = testContext(fakeHost({ e_issue1: stored() }));

    ctx.update("issue", "e_issue1", { title: "First" });
    ctx.update("issue", "e_issue1", { done: true });
    ctx.update("issue", "e_issue1", { title: "Second" });

    expect(projectFields((await ctx.get("e_issue1"))?.data.fields ?? {})).toEqual({
      title: "Second",
      done: true,
      labels: [],
    });
  });

  it("merges a patch of a row created in the same invocation", async () => {
    const ctx = testContext(fakeHost());

    const created = ctx.create(
      "issue",
      { title: "Draft", done: false, labels: [] },
      { id: "e_new", groups: ["g_1"] },
    );
    ctx.update("issue", created.id, { done: true });

    expect(projectFields((await ctx.get(created.id))?.data.fields ?? {})).toEqual({
      title: "Draft",
      done: true,
      labels: [],
    });
  });

  it("yields null for a row created and then deleted in this invocation", async () => {
    const ctx = testContext(fakeHost());

    const created = ctx.create(
      "issue",
      { title: "Gone", done: false, labels: [] },
      { id: "e_new", groups: ["g_1"] },
    );
    ctx.delete("issue", created.id);

    await expect(ctx.get(created.id)).resolves.toBeNull();
  });

  it("yields null for a stored row deleted in this invocation", async () => {
    const ctx = testContext(fakeHost({ e_issue1: stored() }));

    ctx.delete("issue", "e_issue1");

    await expect(ctx.get("e_issue1")).resolves.toBeNull();
  });

  it("keeps a row the host cannot see invisible", async () => {
    const ctx = testContext(fakeHost());

    ctx.update("issue", "e_hidden", { title: "Invisible" });

    await expect(ctx.get("e_hidden")).resolves.toBeNull();
  });

  it("refuses an empty entity id without calling the host", async () => {
    const host = fakeHost();
    const ctx = testContext(host);

    await expect(ctx.get("")).rejects.toThrow(TypeError);
    expect(host.calls).toEqual([]);
  });
});
