/**
 * The shared planner goldens, asserted from the client side of the extraction.
 *
 * Each fixture pins a schema, an invocation id and actor, the id/HLC sequence
 * the planner consumes, a batch of semantic verb calls, and the core Action it
 * must produce. This suite resolves those calls the way the client does — one
 * `commit(calls, capability)` batch through `@ebbjs/write` — and compares the
 * result to the pin, so the runtime's `ctx` path and the client's draft path
 * cannot drift apart without a golden turning red.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Type, type TSchema } from "@sinclair/typebox";
import type { Update } from "@ebbjs/core";
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import {
  commit,
  operationCallFor,
  type CommitCapability,
  type OperationIds,
  type WriteVerb,
} from "@ebbjs/write";
import { describe, expect, it } from "vitest";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../../fixtures/functions/planner/", import.meta.url),
);

interface SchemaSpec {
  readonly version: number;
  readonly entities: Record<string, { readonly fields: Record<string, string> }>;
  readonly relationships?: Record<
    string,
    {
      readonly source: string;
      readonly target: string;
      readonly as: string;
      readonly sourceCardinality?: "one" | "many";
    }
  >;
}

interface PlannerFixture {
  readonly name: string;
  readonly description: string;
  readonly schema: string;
  readonly invocation_id: string;
  readonly actor_id: string;
  readonly ids: Record<string, readonly string[]>;
  readonly calls: readonly WriteVerb[];
  readonly action: {
    readonly id: string;
    readonly actor_id: string;
    readonly hlc: string;
    readonly gsn: number;
    readonly updates: readonly Update[];
  };
}

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(`${FIXTURE_DIR}${file}.json`, "utf8")) as T;

const field = (spec: string): TSchema => {
  switch (spec) {
    case "string":
      return e.string();
    case "boolean":
      return e.boolean();
    case "number":
      return e.number();
    case "string[]":
      return Type.Union([Type.Array(Type.String()), Type.Null()]);
    default:
      throw new Error(`planner fixture: unknown field spec "${spec}"`);
  }
};

const registryFrom = (spec: SchemaSpec) => {
  const entities: Record<string, ReturnType<typeof defineEntity>> = {};
  for (const [name, def] of Object.entries(spec.entities)) {
    entities[name] = defineEntity(
      name,
      Object.fromEntries(
        Object.entries(def.fields).map(([key, type]) => [key, field(type)]),
      ) as Record<string, TSchema>,
    );
  }
  const relationships = Object.fromEntries(
    Object.entries(spec.relationships ?? {}).map(([key, rel]) => [
      key,
      defineRelationship({
        source: entities[rel.source]!,
        target: entities[rel.target]!,
        as: rel.as,
        sourceCardinality: rel.sourceCardinality ?? "one",
      }),
    ]),
  );
  return defineSchema({ entities, relationships, version: spec.version })._registry;
};

/** The ordered id seam a fixture pins; `u` also feeds `updateId()`. */
const idsFrom = (lists: Record<string, readonly string[]>) => {
  const cursors = new Map<string, number>();
  const next = (prefix: string): string => {
    const list = lists[prefix] ?? [];
    const at = cursors.get(prefix) ?? 0;
    const value = list[at];
    if (value === undefined) throw new Error(`fixture id sequence "${prefix}" exhausted at ${at}`);
    cursors.set(prefix, at + 1);
    return value;
  };
  const ids: OperationIds = { updateId: () => next("u"), hlc: () => next("hlc"), newId: next };
  return {
    ids,
    next,
    exhausted: () =>
      Object.entries(lists).every(([prefix, list]) => (cursors.get(prefix) ?? 0) === list.length),
  };
};

/** A JSON serializer with sorted keys, so two structures compare byte for byte. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** The same derivation the server and the runtime use, computed independently. */
const actionId = (invocationId: string): string =>
  `a_${createHash("sha256").update(invocationId, "utf8").digest("hex").slice(0, 16)}`;

const fixtureNames = (): string[] =>
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json") && file !== "schema.json")
    .map((file) => file.slice(0, -".json".length))
    .sort();

describe("planner goldens — client planner path", () => {
  const names = fixtureNames();

  it("finds fixtures", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s plans the pinned Action", async (name) => {
    const fixture = readJson<PlannerFixture>(name);
    const registry = registryFrom(readJson<SchemaSpec>(fixture.schema));
    const sequence = idsFrom(fixture.ids);

    const updates: Update[] = [];
    const capability: CommitCapability = {
      registry,
      actorId: fixture.actor_id,
      freshHlc: () => sequence.ids.hlc(),
      generateUpdateId: () => sequence.ids.updateId(),
      generateId: (prefix: string) => sequence.ids.newId(prefix),
      submitRelationshipUpdates: async (batch) => {
        updates.push(...batch);
        return { rejected: [] };
      },
    };

    const calls = fixture.calls.flatMap((verb) => {
      const entry = operationCallFor(registry, verb);
      return entry === undefined ? [] : [entry];
    });
    const result = await commit(calls, capability);

    expect(result.response.rejected).toEqual([]);
    const action = {
      id: actionId(fixture.invocation_id),
      actor_id: fixture.actor_id,
      hlc: sequence.next("hlc"),
      gsn: 0,
      updates,
    };

    expect(stable(action)).toBe(stable(fixture.action));
    expect(sequence.exhausted()).toBe(true);
  });
});
