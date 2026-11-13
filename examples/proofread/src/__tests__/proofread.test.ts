import type { EntityResponse } from "@ebbjs/client";
import { createContext, type HostOp, type HostTransport } from "@ebbjs/functions-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROOFREAD_ENDPOINT, proofreadDocument } from "../../functions/proofreadDocument";
import type { ProofreadClient } from "../main";
import { schema } from "../schema";

const ACTOR_ID = "a_proofreader";
const DOCUMENT_ID = "doc_1";
const WORKSPACE_ID = "grp_workspace";

const params = { documentId: DOCUMENT_ID, workspaceId: WORKSPACE_ID };

interface HostCall {
  readonly op: HostOp;
  readonly payload: unknown;
}

interface FakeHost {
  readonly calls: HostCall[];
  readonly commits: unknown[];
  readonly transport: HostTransport;
}

/** A recording host; mirrors `packages/functions-runtime/src/test-support/host.ts`. */
const fakeHost = (view: EntityResponse | null): FakeHost => {
  const calls: HostCall[] = [];
  const commits: unknown[] = [];
  return {
    calls,
    commits,
    transport: {
      async call(op, payload) {
        calls.push({ op, payload });
        if (op === "commit") {
          commits.push(payload);
          return { replayed: false };
        }
        return view;
      },
    },
  };
};

/** A stored row as the entity endpoint returns it: `data.fields` are wire leaves. */
const hostRow = (id: string, type: string, fields: Record<string, unknown>): EntityResponse => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        { value, update_id: "u_host", hlc: "111690000000000000" },
      ]),
    ),
  },
  created_hlc: "111690000000000000",
  updated_hlc: "111690000000000000",
  deleted_hlc: null,
  last_gsn: 7,
});

const contextFor = (host: FakeHost) =>
  createContext({
    transport: host.transport,
    invocationId: "inv_proofread",
    actor: { id: ACTOR_ID },
    caller: { kind: "actor", id: ACTOR_ID },
    registry: schema._registry,
  });

interface CommittedUpdate {
  readonly component?: string;
  readonly method: string;
  readonly subject_id: string;
  readonly data?: { readonly value?: unknown };
}

/**
 * The model a committed Update's component names; `undefined` for a delete.
 * A platform component's prefix is the model `ebb`, never its kind, so a
 * membership write reads as `ebb` and its component as `ebb/membership`.
 */
const modelOf = (update: CommittedUpdate): string | undefined =>
  update.component?.slice(0, update.component.indexOf("/"));

interface CommittedAction {
  readonly updates: readonly CommittedUpdate[];
}

const stubFetch = (comments: readonly string[]) => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ comments }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proofreadDocument", () => {
  it("reads the document, proofreads its body, and creates one comment per result", async () => {
    const host = fakeHost(
      hostRow(DOCUMENT_ID, "document", { title: "Draft", body: "teh cat sat" }),
    );
    const ctx = contextFor(host);
    const fetchMock = stubFetch(["the cat sat", "Consider a stronger verb."]);

    await expect(proofreadDocument.handler(ctx, params)).resolves.toEqual({ commentCount: 2 });

    expect(host.calls).toEqual([{ op: "get", payload: { id: DOCUMENT_ID } }]);
    expect(fetchMock).toHaveBeenCalledWith(
      PROOFREAD_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "teh cat sat" }),
      }),
    );

    // The runner flushes at handler return; a direct handler call commits here.
    await ctx.commit();

    const [action] = host.commits as CommittedAction[];
    const models = action?.updates
      .map(modelOf)
      .filter((model, index, all) => model !== all[index - 1]);
    // Each created comment is filed into the workspace group, so every comment
    // write is followed by its `ebb/membership` row under the `ebb` model.
    expect(models).toEqual(["comment", "ebb", "comment", "ebb"]);
    expect(action?.updates.every((update) => update.method === "replace")).toBe(true);

    const components = (action?.updates ?? []).map((update) => update.component);
    expect(components.filter((component) => component === "ebb/membership")).toHaveLength(2);

    const valueOf = (component: string): unknown[] =>
      (action?.updates ?? [])
        .filter((update) => update.component === component)
        .map((update) => update.data?.value);
    expect(valueOf("comment/body")).toEqual(["the cat sat", "Consider a stronger verb."]);
    expect(valueOf("comment/documentId")).toEqual([DOCUMENT_ID, DOCUMENT_ID]);
  });

  it("throws when the document is absent, before any external call or write", async () => {
    const host = fakeHost(null);
    const ctx = contextFor(host);
    const fetchMock = stubFetch(["unused"]);

    await expect(proofreadDocument.handler(ctx, params)).rejects.toThrow(/not found/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.calls).toEqual([{ op: "get", payload: { id: DOCUMENT_ID } }]);
    expect(host.commits).toEqual([]);
  });

  it("throws when the proofreading service fails, leaving the buffer empty", async () => {
    const host = fakeHost(hostRow(DOCUMENT_ID, "document", { title: "Draft", body: "text" }));
    const ctx = contextFor(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );

    await expect(proofreadDocument.handler(ctx, params)).rejects.toThrow(
      /proofreading failed: 503/,
    );

    await ctx.commit();
    expect(host.commits).toEqual([]);
  });
});

/**
 * Type-level proof of the generated contract map. These calls never run; the
 * `@ts-expect-error` comments make `tsc` fail if the shapes stop being checked.
 */
const typeProof = (client: ProofreadClient) => {
  // @ts-expect-error workspaceId is required
  void client.functions.proofreadDocument({ documentId: DOCUMENT_ID });
  // @ts-expect-error documentId must be a string
  void client.functions.proofreadDocument({ documentId: 1, workspaceId: WORKSPACE_ID });
};

void typeProof;
