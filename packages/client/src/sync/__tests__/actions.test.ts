/**
 * Mounting tests for `client.actions` — the schema-bound wrappers
 * `createClient` builds from an `actions` map.
 *
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action: one call is one Action, the drafts resolve in call
 * order, and repeated runs differ only in minted ids and HLCs.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";

import { defineModel, e } from "@ebbjs/schema";
import { defineRelationship } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import { defineAction, type AnyActionDef } from "../../schema/action";
import { createClient } from "../client";
import { updateModel } from "../test-utils";

interface RecordedRequest {
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** Stub `fetch` recording request bodies and accepting handshakes / writes. */
const mkRecordingFetch = (seen: RecordedRequest[]): typeof fetch => {
  return (async (url: string, init: RequestInit): Promise<Response> => {
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : undefined;
    seen.push({ url, body });
    if (url.endsWith("/sync/handshake")) {
      return new Response(
        JSON.stringify({
          actor_id: "actor_1",
          groups: [
            {
              id: "g_1",
              permissions: ["todo.*", "list.*"],
              cursor_valid: true,
              reason: null,
              cursor: 0,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/sync/actions")) {
      return new Response(JSON.stringify({ rejected: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
};

const list = defineModel("list", { name: e.string() });
const todo = defineModel("todo", { title: e.string() });
const schema = defineSchema({
  models: { todo, list },
  relationships: {
    todo_list: defineRelationship({ source: todo, target: list, as: "list" }),
  },
  version: 1,
});

/** Membership option every `create` carries (#244). */
const groups = { groups: ["g_1"] } as const;

/** The definition under test: two entities and one relationship, one Action. */
const createList = defineAction(schema, ({ todo: t, list: l }, params: { title: string }) => {
  const today = l.create({ name: params.title }, groups);
  return { todo: t.create({ title: "Ship it", list: today }, groups), list: today };
});

const ping = defineAction(schema, () => "pong" as const);

const mkClient = <TActions extends Record<string, AnyActionDef>>(actions?: TActions) => {
  const seen: RecordedRequest[] = [];
  const client = createClient({
    serverUrl: "http://localhost:4000",
    actorId: "actor_1",
    schema,
    actions,
    fetchImpl: mkRecordingFetch(seen),
  });
  return { client, seen };
};

const actionCalls = (seen: readonly RecordedRequest[]): RecordedRequest[] =>
  seen.filter((r) => r.url.endsWith("/sync/actions"));

const decodeActions = (request: RecordedRequest): readonly Action[] =>
  decodeSync<{ actions: Action[] }>(request.body!).actions;

/**
 * Normalize a decoded Action for structural comparison. Minted ids,
 * update ids, and HLCs differ per run. Every id is mapped to a stable
 * placeholder in first-seen order; id-valued relationship fields are
 * mapped too. The two runs under comparison share the resolver, so
 * their first-seen order is identical.
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
  const canonicalUpdates = action.updates.map((update) => {
    if (update.method === "drop" || update.method === "delete") {
      return { subject_id: idOf(update.subject_id), method: update.method };
    }
    const leaf = update.data;
    // A platform row's ids live inside its atomic value, so canonicalize the
    // id-valued keys of the object as well as a leaf's own value.
    const idKeys = new Set(["source_id", "target_id", "entity_id", "actor_id"]);
    const canonicalValue = (value: unknown): unknown =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
              key,
              idKeys.has(key) && typeof entry === "string" ? idOf(entry) : entry,
            ]),
          )
        : value;
    const value =
      "value" in leaf &&
      (update.component.endsWith("/source_id") ||
        update.component.endsWith("/target_id") ||
        update.component.endsWith("/entity_id"))
        ? idOf(leaf.value as string)
        : canonicalValue(leaf.value);
    return {
      subject_id: idOf(update.subject_id),
      component: update.component,
      method: update.method,
      data: value,
    };
  });
  return canonicalUpdates.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

describe("client.actions mounting", () => {
  it("mounts a fresh wrapper, never the frozen definition", () => {
    const { client } = mkClient({ createList });
    expect(client.actions.createList).not.toBe(createList);
  });

  it("mounts one definition under several names as distinct wrappers", () => {
    const { client } = mkClient({ first: createList, second: createList });
    expect(client.actions.first).not.toBe(client.actions.second);
    expect(client.actions.first.name).toBe("first");
    expect(client.actions.second.name).toBe("second");
  });

  it("exposes an empty `actions` map when none are passed", () => {
    const seen: RecordedRequest[] = [];
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      schema,
      fetchImpl: mkRecordingFetch(seen),
    });
    expect(client.actions).toEqual({});
  });

  it("does not expose `actions` without a schema", () => {
    const seen: RecordedRequest[] = [];
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "actor_1",
      fetchImpl: mkRecordingFetch(seen),
    });
    expect((client as { actions?: unknown }).actions).toBeUndefined();
  });

  it("returns the callback's Result and resolves params from the call", async () => {
    const { client } = mkClient({ createList, ping });
    await client.handshake();

    const created = await client.actions.createList({ title: "Today" });
    expect(created.list.name).toBe("Today");
    expect(created.todo.title).toBe("Ship it");
    expect(created.todo.list).toBe(created.list.id);
    expect(await client.actions.ping()).toBe("pong");
  });

  it("makes the wrapper zero-arg when Params is void", () => {
    const { client } = mkClient({ ping });
    // Wrapped so the type-level assertion is checked without running.
    const expectNoParams: () => void = () => {
      // @ts-expect-error — `ping` declares no params.
      client.actions.ping({ title: "nope" });
    };
    expect(expectNoParams).toBeTypeOf("function");
  });

  it("requires params when the definition declares them", () => {
    const { client } = mkClient({ createList });
    const expectParams: () => void = () => {
      // @ts-expect-error — `createList` requires `{ title: string }`.
      client.actions.createList();
    };
    expect(expectParams).toBeTypeOf("function");
  });
});

describe("client.actions composition", () => {
  it("composes structurally identical Actions on repeated calls, with fresh ids", async () => {
    const { client, seen } = mkClient({ createList });
    await client.handshake();

    const first = await client.actions.createList({ title: "Today" });
    const second = await client.actions.createList({ title: "Today" });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(2);
    expect(decodeActions(calls[0]!)).toHaveLength(1);
    expect(decodeActions(calls[1]!)).toHaveLength(1);
    expect(canonicalize(decodeActions(calls[0]!)[0]!)).toEqual(
      canonicalize(decodeActions(calls[1]!)[0]!),
    );
    // Ids differ per run, so the comparison above is not a tautology.
    expect(first.list.id).not.toBe(second.list.id);
  });

  it("resolves the drafts in call order: the list put precedes the todo that points at it", async () => {
    const { client, seen } = mkClient({ createList });
    await client.handshake();

    const created = await client.actions.createList({ title: "Today" });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(1);
    const [action] = decodeActions(calls[0]!);
    const models = action!.updates
      .map((update) => updateModel(update))
      .filter((model, index, all) => model !== all[index - 1]);
    expect(models).toEqual(["list", "ebb", "todo", "ebb"]);
    // The membership and the link are one atomic value each.
    const components = action!.updates.flatMap((update) =>
      update.method === "delete" ? [] : [update.component],
    );
    expect(components.filter((component) => component.startsWith("ebb/"))).toEqual([
      "ebb/membership",
      "ebb/membership",
      "ebb/link",
    ]);
    const target = action!.updates.find(
      (update) => update.method !== "delete" && update.component === "ebb/link",
    )!;
    expect(target.data).toMatchObject({ value: { target_id: created.list.id } });
  });
});
