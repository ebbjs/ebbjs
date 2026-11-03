/**
 * Test support: a recording host transport, a deterministic id/clock seam, and
 * a context wired to the planner fixture schema.
 */

import type { FieldValue } from "@ebbjs/core";
import type { EntityResponse } from "@ebbjs/client";
import { projectFieldValue, type OperationIds } from "@ebbjs/write";

import { createContext, type Context, type HostOp, type HostTransport } from "../index.ts";
import { loadSpec, registryFrom } from "./planner.ts";

export interface HostCall {
  readonly op: HostOp;
  readonly payload: unknown;
}

/** A host that answers reads from a view map and records commit payloads. */
export interface FakeHost {
  readonly transport: HostTransport;
  readonly calls: HostCall[];
  readonly commits: unknown[];
  readonly views: Map<string, EntityResponse | null>;
  /** The value a commit resolves to; defaults to `{ replayed: false }`. */
  reply: unknown;
  /** When set, a commit rejects with this value instead of resolving. */
  error: unknown;
}

export const fakeHost = (views: Record<string, EntityResponse | null> = {}): FakeHost => {
  const calls: HostCall[] = [];
  const commits: unknown[] = [];
  const host: FakeHost = {
    calls,
    commits,
    views: new Map(Object.entries(views)),
    reply: { replayed: false },
    error: undefined,
    transport: {
      async call(op, payload) {
        calls.push({ op, payload });
        if (op === "commit") {
          commits.push(payload);
          if (host.error !== undefined) throw host.error;
          return host.reply;
        }
        return host.views.get((payload as { id: string }).id) ?? null;
      },
    },
  };
  return host;
};

/** A clock-and-id seam whose values are readable and stable within one test. */
export const countingIds = (): OperationIds & { readonly minted: string[] } => {
  const counters = new Map<string, number>();
  const minted: string[] = [];
  const tick = (prefix: string): number => {
    const count = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, count);
    return count;
  };
  const next = (prefix: string): string => `${prefix}_test${tick(prefix)}`;
  return {
    updateId: () => next("u"),
    hlc: () => String(111690000000000000n + BigInt(tick("hlc"))),
    newId: next,
    minted,
  };
};

/** A stored row as the host's `get` returns it. */
/** A projected value as the wire leaf the host's view carries. */
const wireField = (value: unknown, stamp: string): FieldValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? {
        map: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            wireField(entry, stamp),
          ]),
        ),
      }
    : { value, update_id: "u_host", hlc: stamp };

/** A stored row as the host's `get` returns it: `data.fields` are wire leaves. */
export const hostRow = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  extra: Partial<EntityResponse> = {},
): EntityResponse => {
  const stamp = "111690000000000000";
  return {
    id,
    type,
    data: {
      fields: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, wireField(value, stamp)]),
      ),
    },
    created_hlc: stamp,
    updated_hlc: stamp,
    deleted_hlc: null,
    last_gsn: 7,
    ...extra,
  };
};

/** Project a view's wire fields back to the plain values a handler reads. */
export const projectFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, projectFieldValue(value as FieldValue)]),
  );

export interface TestContextOptions {
  readonly ids?: OperationIds;
  readonly invocationId?: string;
  readonly actorId?: string;
}

/** A context over the planner fixture schema, wired to `host`. */
export const testContext = (host: FakeHost, options: TestContextOptions = {}): Context =>
  createContext({
    transport: host.transport,
    invocationId: options.invocationId ?? "inv_test",
    actor: { id: options.actorId ?? "a_test" },
    caller: { kind: "actor", id: options.actorId ?? "a_test" },
    registry: registryFrom(loadSpec("schema")),
    ids: options.ids ?? countingIds(),
  });
