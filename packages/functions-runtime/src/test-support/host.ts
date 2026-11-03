/**
 * Test support: a recording host transport, a deterministic id/clock seam, and
 * a context wired to the planner fixture schema.
 */

import type { EntityResponse } from "@ebbjs/client";
import type { OperationIds } from "@ebbjs/write";

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
export const hostRow = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  extra: Partial<EntityResponse> = {},
): EntityResponse => ({
  id,
  type,
  data: { fields },
  created_hlc: "111690000000000000",
  updated_hlc: "111690000000000000",
  deleted_hlc: null,
  last_gsn: 7,
  ...extra,
});

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
