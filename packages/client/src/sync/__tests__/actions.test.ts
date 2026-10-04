/**
 * Mounting tests for `client.actions` — the schema-bound wrappers
 * `createClient` builds from an `actions` map.
 *
 * The stub `fetch` records every request so the tests can decode the
 * submitted Action and compare the wrapper's composition against the
 * equivalent `client.atomic(...)` callback. Minted ids and HLCs differ
 * per run, so the comparison canonicalizes them away.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, type Action } from "@ebbjs/core";

import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { defineAction, type AnyActionDef } from "../../schema/action";
import { createClient } from "../client";

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

const list = defineEntity("list", { name: e.string() });
const todo = defineEntity("todo", { title: e.string() });
const schema = defineSchema({
  entities: { todo, list },
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
  const canonicalUpdates = action.updates.map((update) => ({
    subject_id: idOf(update.subject_id),
    subject_type: update.subject_type,
    method: update.method,
    fields: Object.fromEntries(
      Object.entries(update.data?.fields ?? {}).map(([key, env]) => {
        const value =
          key === "source_id" || key === "target_id" || key === "entity_id"
            ? idOf(env.value as string)
            : env.value;
        return [key, value];
      }),
    ),
  }));
  return canonicalUpdates.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

describe("client.actions mounting", () => {
  it("mounts one wrapper per key with `.name` equal to the map key", async () => {
    const { client } = mkClient({ createList, ping });
    await client.handshake();

    expect(typeof client.actions.createList).toBe("function");
    expect(client.actions.createList.name).toBe("createList");
    expect(client.actions.ping.name).toBe("ping");
  });

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

describe("client.actions equivalence", () => {
  it("composes the same Action as the equivalent client.atomic callback", async () => {
    const { client, seen } = mkClient({ createList });
    await client.handshake();

    const viaActions = await client.actions.createList({ title: "Today" });
    const viaAtomic = await client.atomic(({ todo: t, list: l }) => {
      const today = l.create({ name: "Today" }, groups);
      return { todo: t.create({ title: "Ship it", list: today }, groups), list: today };
    });

    const calls = actionCalls(seen);
    expect(calls).toHaveLength(2);
    expect(decodeActions(calls[0]!)).toHaveLength(1);
    expect(decodeActions(calls[1]!)).toHaveLength(1);
    expect(canonicalize(decodeActions(calls[0]!)[0]!)).toEqual(
      canonicalize(decodeActions(calls[1]!)[0]!),
    );
    // Ids differ per run, so the comparison above is not a tautology.
    expect(viaActions.todo.id).not.toBe(viaAtomic.todo.id);
  });
});
