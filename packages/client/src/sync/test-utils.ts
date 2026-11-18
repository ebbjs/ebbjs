/**
 * Shared fixtures and fetch mocks for the sync client's tests.
 *
 * Fixtures — `entityRow` / `linkRow` / `membershipRow` build materialized rows,
 * `stampedRow` takes field values the test stamped itself, and `platformEntity`
 * stays the escape hatch for a platform row built field by field.
 *
 * Assertions on written Updates — `rowsByModel` groups a write's Updates into
 * one list per subject row, and `rowFields` reads a row's values back.
 *
 * Timing — `flushTasks` yields one macrotask turn; `waitFor` polls.
 *
 * Transport — `makeFetchMock(responses)` records every call and returns canned
 * `Response` objects from a FIFO queue. Models the ebb server's non-streaming
 * HTTP endpoints (`/sync/handshake`, `/sync/actions`, `/entities/...`).
 * `makeStreamingFetch(chunks, options)` returns the same streaming `Response`
 * for every call, with the body built from pre-encoded SSE byte chunks. Models
 * the `/sync/live` SSE endpoint.
 *
 * Harness — `testActions(schema)` mounts a name-addressed actions map so a test
 * writes through `client.actions.<name>` like application code does.
 *
 * The mock functions are typed as `MockInstance<...>` rather than the looser
 * `vi.fn` default, so call sites can access `.mock.calls` without an
 * `as unknown as { mock: ... }` cast and IntelliJ navigates into the mock
 * object.
 */
import { vi, type MockInstance } from "vitest";

import {
  componentName,
  ebbComponent,
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponentField,
  isComponentUpdate,
  isEbbComponent,
  isFieldMap,
  makeHlc,
  updateModel,
  type Action,
  type EbbComponentKind,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/types";
import { defineAction } from "../schema/action";
import type { createClient } from "./client";
import type { ActionDrafts, DuplicateAt, GroupRef } from "./drafts";
import { isGroupListingUrl } from "./endpoints";
import type { PointerValue } from "./query-builder";
import type { ManyPointerValue } from "./relationship";

/** A non-streaming `Response` shape — body is a string or binary buffer. */
export interface FetchMockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** A single recorded fetch call. */
export interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Drive the private `_applyAction` method on a SyncClient.
 *
 * Tests that need to seed storage state without driving the full SSE /
 * HTTP path call this through the test-only cast pattern. The two-arg
 * shape (`groupId?`) matches the production method so callers can
 * omit the group when irrelevant.
 */
export const callApplyAction = (
  client: ReturnType<typeof createClient>,
  action: Action,
  groupId?: string,
): Promise<{ entityId: string }[]> =>
  (
    client as unknown as {
      _applyAction: (a: Action, g?: string) => Promise<{ entityId: string }[]>;
    }
  )._applyAction.call(client, action, groupId);

let seedPosition = 0;

/**
 * Fold a seeded row into the replica through the same durable
 * Action / Update path the client uses. The replica is the client's
 * read path, so a row a test writes with `storage.entities.set` is
 * invisible to a query unless it is folded here too.
 *
 * Call this before the shim write: production ingests the Action (which
 * wakes the replica signal) before the shim is materialized.
 */
export const seedReplicaRow = (
  replica: Replica,
  row: Entity,
  method: "replace" | "delete" = row.deleted_hlc === null ? "replace" : "delete",
): void => {
  seedPosition += 1;
  const hlc = makeHlc(seedPosition);
  const updates: Update[] =
    method === "replace"
      ? [
          {
            id: `u_seed_${seedPosition}_create`,
            subject_id: row.id,
            model: row.model,
            method: "create",
            hlc: row.created_hlc ?? hlc,
            data: null,
          },
          ...Object.entries(row.data.fields).map(([field, value], index) => ({
            id: `u_seed_${seedPosition}_${index}`,
            subject_id: row.id,
            component: componentName(row.model, field),
            method: isFieldMap(value) ? ("merge" as const) : ("replace" as const),
            data: value,
          })),
        ]
      : [
          {
            id: `u_seed_${seedPosition}`,
            subject_id: row.id,
            method: "delete",
            data: null,
          },
        ];
  const action: Action = {
    id: `a_seed_${seedPosition}`,
    actor_id: "seed",
    hlc,
    gsn: seedPosition,
    updates: [],
  };
  replica.ingest(action, updates, seedPosition);
};

/** Whether `model` names a platform component rather than a user model. */
export const isPlatformModel = (model: string): model is EbbComponentKind =>
  (EBB_COMPONENT_KINDS as readonly string[]).includes(model);

/**
 * The `(component, value)` pairs a fixture row write emits. A user row emits one
 * per field; a platform row (`membership`, `grant`, …) emits one whole value.
 */
export const rowComponents = (
  model: string,
  fields: Record<string, unknown>,
): readonly (readonly [`${string}/${string}`, unknown])[] =>
  isPlatformModel(model)
    ? [[ebbComponent(model), fields] as const]
    : Object.entries(fields).map(([key, value]) => [componentName(model, key), value] as const);

/** A materialized platform row: an `ebb` row carrying one atomic component. */
export const platformEntity = (
  id: string,
  kind: EbbComponentKind,
  values: Record<string, unknown>,
  deletedHlc: string | null = null,
): Entity => ({
  id,
  model: EBB_MODEL_NAME,
  data: {
    fields: {
      [ebbComponentField(kind)]: { value: values, update_id: "u_1", hlc: "1-0" },
    },
  },
  exists: true,
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: deletedHlc,
  last_gsn: 0,
});

/** Stamps a hand-built row carries; every one is optional so a fixture names
 * only the stamp the test asserts on. */
export interface EntityRowOptions {
  /** `update_id` written onto every field value. */
  updateId?: string;
  /**
   * `hlc` written onto every field value. Left off by default: a field value
   * without one carries no stamp, which is what a projection-only row needs.
   */
  hlc?: string;
  createdHlc?: string;
  /** A non-null value marks the row as a tombstone. */
  deletedHlc?: string | null;
  lastGsn?: number;
}

/**
 * A materialized user row from field values the test has already stamped
 * (`update_id`, `hlc`, nested `map`s). `entityRow` is the shorthand for a row
 * whose fields are plain values.
 */
export const stampedRow = (
  id: string,
  model: string,
  fields: Record<string, FieldValue>,
  { createdHlc = "1", deletedHlc = null, lastGsn = 0 }: EntityRowOptions = {},
): Entity => ({
  id,
  model,
  data: { fields },
  exists: true,
  created_hlc: createdHlc,
  updated_hlc: createdHlc,
  deleted_hlc: deletedHlc,
  last_gsn: lastGsn,
});

/**
 * A materialized user row: the shape a read path sees once the row's
 * components have landed. Platform rows use `platformEntity`, which carries
 * one atomic component instead of one component per field.
 */
export const entityRow = (
  id: string,
  model: string,
  fields: Record<string, unknown>,
  { updateId = "u_1", hlc, ...stamps }: EntityRowOptions = {},
): Entity =>
  stampedRow(
    id,
    model,
    Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [
        field,
        hlc === undefined ? { value, update_id: updateId } : { value, update_id: updateId, hlc },
      ]),
    ),
    stamps,
  );

/**
 * A materialized `ebb/link` row. `field` and `type` name the relationship the
 * link realizes, so a traversal can tell two links on one row apart.
 */
export const linkRow = (
  id: string,
  sourceId: string,
  targetId: string,
  field: string,
  type: string,
  deletedHlc: string | null = null,
): Entity =>
  platformEntity(id, "link", { source_id: sourceId, target_id: targetId, field, type }, deletedHlc);

/**
 * A materialized `ebb/membership` row. An omitted `groupId` writes none, the
 * shape of a membership filed before the group was assigned.
 */
export const membershipRow = (
  id: string,
  entityId: string,
  groupId: string | undefined,
  deletedHlc: string | null = null,
): Entity =>
  platformEntity(
    id,
    "membership",
    groupId === undefined ? { entity_id: entityId } : { entity_id: entityId, group_id: groupId },
    deletedHlc,
  );

/**
 * The Updates a platform row write implies: its create and one atomic
 * component, whole value. A patch of a row that already exists is the
 * component alone.
 */
export const platformUpdate = (
  subjectId: string,
  kind: EbbComponentKind,
  method: "put" | "patch" | "delete",
  values: Record<string, unknown> = {},
): Update[] => {
  if (method === "delete") {
    return [{ id: `u_${subjectId}_delete`, subject_id: subjectId, method: "delete", data: null }];
  }
  const component: Update = {
    id: `u_${subjectId}_${method}`,
    subject_id: subjectId,
    component: ebbComponent(kind),
    method: "replace",
    data: { value: values, update_id: `u_${subjectId}_${method}`, hlc: makeHlc(1) },
  };
  if (method === "patch") return [component];
  return [
    {
      id: `u_${subjectId}_create`,
      subject_id: subjectId,
      model: EBB_MODEL_NAME,
      method: "create",
      hlc: makeHlc(1),
      data: null,
    },
    component,
  ];
};

/**
 * Updates grouped by subject, keeping only the rows of `model` — a user model,
 * or a platform kind, which matches the rows carrying its component. A
 * platform row's create names the `ebb` model rather than the kind, so it
 * belongs to the subject's group but to no particular kind.
 */
export const rowsByModel = (
  updates: readonly Update[],
  model: string,
): readonly (readonly Update[])[] => {
  const matches = (update: Update): boolean =>
    isPlatformModel(model)
      ? isComponentUpdate(update) && update.component === ebbComponent(model)
      : updateModel(update) === model;
  const bySubject = new Map<string, Update[]>();
  for (const update of updates) {
    if (!matches(update)) continue;
    const row = bySubject.get(update.subject_id);
    if (row === undefined) bySubject.set(update.subject_id, [update]);
    else row.push(update);
  }
  return [...bySubject.values()];
};

/**
 * A row's field values, keyed by field. A user row names one component per field;
 * a platform row's value keys are the fields.
 */
export const rowFields = (row: readonly Update[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const update of row) {
    if (!isComponentUpdate(update) || update.method === "drop") continue;
    const value = (update.data as { value: unknown }).value;
    if (isEbbComponent(update.component)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(out, value as Record<string, unknown>);
      }
      continue;
    }
    out[update.component.slice(update.component.indexOf("/") + 1)] = value;
  }
  return out;
};

/**
 * A request that stays in flight until its signal aborts, the way a real fetch
 * behaves against a server that has not answered yet. Rejecting with the
 * signal's own reason keeps the error shape undici produces. Answering a
 * request that carried no signal with an error rather than a hang makes a
 * broken wiring fail the test instead of timing out.
 */
export const pendingUntilAborted = (init: RequestInit | undefined): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) {
      reject(new Error("test fetch: request carried no abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** The URL a fetch mock was called with, as a string. */
export const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input.toString();

/** A locally-authored put the Outbox will try to post. */
export const localPut = (id: string, actorId: string, subjectId = "todo_1"): Action => {
  const hlc = makeHlc(1711036800000);
  return {
    id,
    actor_id: actorId,
    hlc,
    gsn: 0,
    updates: [
      {
        id: `u_${id}_0`,
        subject_id: subjectId,
        component: "todo/title",
        method: "replace",
        data: { value: "parked", update_id: `u_${id}`, hlc },
      },
    ],
  };
};

/** A JSON `Response` carrying `body` and optional extra headers. */
export const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

/** Catch-up `GET /sync/groups/:id` response reporting nothing missed. */
export const emptyCatchUpResponse = (): Response =>
  jsonResponse([], { "stream-up-to-date": "true" });

/**
 * Whether `url` is the group listing (`GET /sync/groups/:id/entities`). The
 * listing and the catch-up share a path prefix, so a path-dispatching mock
 * has to tell them apart before it branches on `/sync/groups/`. Answered by
 * the same route module the client builds its URLs from, so a route change
 * cannot leave this mock dispatching on a prefix that no longer exists.
 */
export const isListingRequest = (url: string): boolean => isGroupListingUrl(url);

/**
 * A group listing page with no rows. Every cold bootstrap asks for one
 * before catch-up, so a path-dispatching mock serves this to stay on the
 * log path; `watermark` is the GSN the client then resumes from.
 */
export const emptyListingResponse = (watermark = 0, groupId = "grp_1"): Response =>
  jsonResponse({ group_id: groupId, watermark, cursor: null, has_more: false, entities: [] });

/** An SSE `Response` whose body never ends, keeping a subscription live. */
export const openSseResponse = (): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** An SSE `Response` that emits pre-encoded `chunks` and then closes. */
export const closingSseResponse = (chunks: readonly string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

/**
 * Build a `fetch` mock that records calls and returns canned responses
 * from a FIFO queue. The last entry is returned for any call after the
 * queue is drained (so a "default" response can be stashed at the end
 * of the array).
 */
export function makeFetchMock(responses: FetchMockResponse[]): {
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> &
    typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift() ?? queue[queue.length - 1];
    if (!next) {
      throw new Error("fetchMock: no more responses queued");
    }
    const headers = new Headers(next.headers ?? {});
    return new Response((next.body ?? "") as BodyInit, {
      status: next.status ?? 200,
      headers,
    });
  }) as unknown as MockInstance<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  > &
    typeof fetch;
  return { fn, calls };
}

/**
 * Build a `fetch` mock that returns a streaming `Response` whose body is
 * the concatenation of the given pre-encoded SSE byte chunks.
 *
 * For mocks that need per-URL branching or a fully custom `ReadableStream`,
 * write an inline `vi.fn` instead — this helper covers the uniform case
 * used by `openSSEStream` integration tests.
 */
export function makeStreamingFetch(
  chunks: string[],
  options: { status?: number; headers?: Record<string, string> } = {},
): {
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> &
    typeof fetch;
  calls: FetchCall[];
} {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(body, {
      status: options.status ?? 200,
      headers: new Headers(options.headers ?? { "content-type": "text/event-stream" }),
    });
  }) as unknown as MockInstance<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  > &
    typeof fetch;
  return { fn, calls };
}

/**
 * Yield one macrotask turn, so every microtask (and zero-delay timer) queued
 * before it has run. Reach for `waitFor` instead when the work being awaited
 * is a promise chain whose length the test cannot pin.
 */
export const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Poll `predicate` until it holds, or throw after `timeoutMs`. Waiting on
 * the durable store beats a fixed sleep, which couples a test to
 * scheduler timing.
 */
export const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ---------------------------------------------------------------------------
// The name-addressed action harness
// ---------------------------------------------------------------------------

/**
 * TEST HARNESS — not public API, not shipped.
 *
 * `testActions(schema)` builds an actions map mounted on a client, so a test
 * writes through `client.actions.<name>` exactly as application code does.
 * Verbs are addressed by entity name (`{ entity: "todo", id, patch }`) for
 * tests where the write is setup; `run` executes an arbitrary callback over the
 * typed drafts. A test whose subject *is* the write should declare typed
 * actions instead, so it pins the draft surface. The casts that keep call sites
 * clean live here only.
 */

/** A draft `create` / `duplicate` handle, as seen by a name-addressed verb. */
type LooseHandle = { readonly id: string } & Record<string, unknown>;

/** A system draft namespace (`group` / `membership`): `create` takes the row only. */
interface LooseSystemDraft {
  create(input: Record<string, unknown>): LooseHandle;
}

/** Per-entity draft surface, erased to a name-addressed view. */
interface LooseDraft {
  create(
    input: Record<string, unknown>,
    opts: { groups: readonly GroupRef[] | undefined; validate?: boolean },
  ): LooseHandle;
  update(id: string, patch: Record<string, unknown>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
  duplicate(
    id: string,
    opts?: {
      at?: DuplicateAt;
      groups?: readonly GroupRef[];
      validate?: boolean;
    },
  ): LooseHandle;
  link(id: string, as: string, target: PointerValue): void;
  unlink(id: string, as: string): void;
  setLinks(id: string, as: string, patch: ManyPointerValue): void;
  addToGroup(id: string, groupId: GroupRef): void;
  removeFromGroup(id: string, groupId: GroupRef): void;
  setGroups(id: string, groupIds: readonly GroupRef[]): void;
}

/** The `grant` draft namespace: `create` plus the guarded patch/delete pair. */
interface LooseMembershipDraft extends LooseSystemDraft {
  update(id: string, patch: Record<string, unknown>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
}

/** The whole draft surface, keyed by entity name plus the system namespaces. */
type LooseDrafts = Record<string, LooseDraft> & {
  group: LooseSystemDraft;
  membership: LooseMembershipDraft;
};

/** Erase the schema-typed drafts to the name-addressed view. */
const loose = (drafts: unknown): LooseDrafts => drafts as LooseDrafts;

/** The entity's draft namespace; an unknown name is the test's mistake. */
const entityOf = (drafts: LooseDrafts, entity: string): LooseDraft => {
  const namespace = drafts[entity];
  if (namespace === undefined) {
    throw new Error(`testActions: no entity "${entity}" on the schema`);
  }
  return namespace;
};

interface CreateParams {
  readonly entity: string;
  readonly input: Record<string, unknown>;
  readonly groups?: readonly GroupRef[];
  readonly validate?: boolean;
}

interface UpdateParams {
  readonly entity: string;
  readonly id: string;
  readonly patch: Record<string, unknown>;
  readonly validate?: boolean;
}

interface DeleteParams {
  readonly entity: string;
  readonly id: string;
}

interface DuplicateParams {
  readonly entity: string;
  readonly id: string;
  readonly at?: DuplicateAt;
  readonly groups?: readonly GroupRef[];
  readonly validate?: boolean;
}

interface LinkParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target: PointerValue;
}

interface UnlinkParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
}

interface SetLinksParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly targets: ManyPointerValue;
}

interface GroupVerbParams {
  readonly entity: string;
  readonly id: string;
  readonly group: GroupRef;
}

interface SetGroupsParams {
  readonly entity: string;
  readonly id: string;
  readonly groups: readonly GroupRef[];
}

interface CreateSystemParams {
  readonly input: Record<string, unknown>;
}

interface UpdateMembershipParams {
  readonly id: string;
  readonly patch: Record<string, unknown>;
  readonly validate?: boolean;
}

interface MembershipIdParams {
  readonly id: string;
}

/**
 * One mounted-ready action per draft verb, plus `run`. Every action takes
 * its arguments as a single params object, so a test dispatches a write
 * with one call and no per-test declaration.
 */
export const testActions = <S>(schema: S) => ({
  create: defineAction(schema, (drafts, params: CreateParams) => {
    const { entity, input, groups, validate } = params;
    return entityOf(loose(drafts), entity).create(input, { groups, validate });
  }),
  update: defineAction(schema, (drafts, params: UpdateParams): void => {
    const { entity, id, patch, validate } = params;
    entityOf(loose(drafts), entity).update(id, patch, { validate });
  }),
  delete: defineAction(schema, (drafts, params: DeleteParams): void => {
    entityOf(loose(drafts), params.entity).delete(params.id);
  }),
  duplicate: defineAction(schema, (drafts, params: DuplicateParams) => {
    const { entity, id, at, groups, validate } = params;
    return entityOf(loose(drafts), entity).duplicate(id, { at, groups, validate });
  }),
  link: defineAction(schema, (drafts, params: LinkParams): void => {
    const { entity, id, as, target } = params;
    entityOf(loose(drafts), entity).link(id, as, target);
  }),
  unlink: defineAction(schema, (drafts, params: UnlinkParams): void => {
    entityOf(loose(drafts), params.entity).unlink(params.id, params.as);
  }),
  setLinks: defineAction(schema, (drafts, params: SetLinksParams): void => {
    const { entity, id, as, targets } = params;
    entityOf(loose(drafts), entity).setLinks(id, as, targets);
  }),
  addToGroup: defineAction(schema, (drafts, params: GroupVerbParams): void => {
    const { entity, id, group } = params;
    entityOf(loose(drafts), entity).addToGroup(id, group);
  }),
  removeFromGroup: defineAction(schema, (drafts, params: GroupVerbParams): void => {
    const { entity, id, group } = params;
    entityOf(loose(drafts), entity).removeFromGroup(id, group);
  }),
  setGroups: defineAction(schema, (drafts, params: SetGroupsParams): void => {
    const { entity, id, groups } = params;
    entityOf(loose(drafts), entity).setGroups(id, groups);
  }),
  createGroup: defineAction(schema, (drafts, params: CreateSystemParams) =>
    loose(drafts).group.create(params.input),
  ),
  createMembership: defineAction(schema, (drafts, params: CreateSystemParams) =>
    loose(drafts).membership.create(params.input),
  ),
  updateMembership: defineAction(schema, (drafts, params: UpdateMembershipParams): void => {
    const { id, patch, validate } = params;
    loose(drafts).membership.update(id, patch, { validate });
  }),
  deleteMembership: defineAction(schema, (drafts, params: MembershipIdParams): void => {
    loose(drafts).membership.delete(params.id);
  }),
  // `any` rather than the callback's own type: a definition's Result is
  // fixed when it is declared, while a test callback varies per call.
  run: defineAction(schema, (drafts, build: (drafts: ActionDrafts<S>) => any) =>
    build(drafts as ActionDrafts<S>),
  ),
});
