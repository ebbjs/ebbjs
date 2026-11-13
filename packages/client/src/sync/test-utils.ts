/**
 * Shared fetch-mock helpers for sync-client unit tests.
 *
 * Two helpers live here:
 *
 * - `makeFetchMock(responses)` — records every call and returns canned
 *   `Response` objects from a FIFO queue. Models the ebb server's
 *   non-streaming HTTP endpoints (`/sync/handshake`, `/sync/actions`,
 *   `/entities/...`).
 *
 * - `makeStreamingFetch(chunks, options)` — returns the same streaming
 *   `Response` for every call, with the body built from pre-encoded SSE
 *   byte chunks. Models the `/sync/live` SSE endpoint.
 *
 * The mock functions are typed as `MockInstance<...>` rather than the
 * looser `vi.fn` default, so call sites can access `.mock.calls` without
 * an `as unknown as { mock: ... }` cast and IntelliJ navigates into the
 * mock object.
 */
import { vi, type MockInstance } from "vitest";
import {
  componentModel,
  componentName,
  EBB_COMPONENTS,
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponentField,
  isEbbComponent,
  isFieldMap,
  makeHlc,
  type Action,
  type EbbComponentKind,
  type Entity,
  type Update,
} from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/types";
import type { createClient } from "./client";

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
      ? Object.entries(row.data.fields).map(([field, value], index) => ({
          id: `u_seed_${seedPosition}_${index}`,
          subject_id: row.id,
          component: componentName(row.type, field),
          method: isFieldMap(value) ? "merge" : "replace",
          data: value,
        }))
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
    ? [[EBB_COMPONENTS[model], fields] as const]
    : Object.entries(fields).map(([key, value]) => [componentName(model, key), value] as const);

/** A materialized platform row: an `ebb` row carrying one atomic component. */
export const platformEntity = (
  id: string,
  kind: EbbComponentKind,
  values: Record<string, unknown>,
  deletedHlc: string | null = null,
): Entity => ({
  id,
  type: EBB_MODEL_NAME,
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

/** The Update a platform row write implies: one atomic component, whole value. */
export const platformUpdate = (
  subjectId: string,
  kind: EbbComponentKind,
  method: "put" | "patch" | "delete",
  values: Record<string, unknown> = {},
): Update[] => {
  if (method === "delete") {
    return [{ id: `u_${subjectId}_delete`, subject_id: subjectId, method: "delete", data: null }];
  }
  return [
    {
      id: `u_${subjectId}_${method}`,
      subject_id: subjectId,
      component: EBB_COMPONENTS[kind],
      method: "replace",
      data: { value: values, update_id: `u_${subjectId}_${method}`, hlc: makeHlc(1) },
    },
  ];
};

/**
 * Updates grouped by subject, keeping only the rows of `model` — a user model,
 * or a platform kind, which matches the rows carrying its component.
 */
export const rowsByModel = (
  updates: readonly Update[],
  model: string,
): readonly (readonly Update[])[] => {
  const matches = (update: Update): boolean =>
    isPlatformModel(model)
      ? update.method !== "delete" && update.component === EBB_COMPONENTS[model]
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
    if (update.method === "drop" || update.method === "delete") continue;
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

/** The model an Update commits under; `undefined` for a delete, which names none. */
export const updateModel = (update: Update): string | undefined =>
  update.method === "delete" ? undefined : componentModel(update.component);

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
 * has to tell them apart before it branches on `/sync/groups/`.
 */
export const isListingRequest = (url: string): boolean =>
  url.includes("/sync/groups/") && url.includes("/entities");

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
