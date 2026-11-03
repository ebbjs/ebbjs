/**
 * Test support for the planner reference fixtures.
 *
 * The fixtures under `fixtures/functions/planner/` pin the wire Action a batch
 * of semantic verbs must produce. Both surfaces that plan those verbs — the
 * client's batch commit and the functions runtime's buffered `ctx` — must
 * speak the same fixture format, so the loader lives here rather than in
 * either test tree.
 *
 * Not part of the runtime API: this entry reads from disk and exists for
 * tests. It is exported as `@ebbjs/functions-protocol/testing` and, like the
 * package, is private to the workspace.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Type, type TSchema } from "@sinclair/typebox";

import type { Update } from "@ebbjs/core";
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";
import type { OperationIds, WriteVerb } from "@ebbjs/write";

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/functions/planner/", import.meta.url));

/** One entity's declarative field map, as the fixture pins it. */
export interface SchemaSpec {
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

export interface PlannerFixture {
  readonly name: string;
  readonly description: string;
  readonly notes?: string;
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

/** Build the registry a fixture's schema spec describes. */
export const registryFrom = (spec: SchemaSpec) => {
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
export interface IdSequence extends OperationIds {
  readonly next: (prefix: string) => string;
  /** True once every pinned id has been consumed. */
  exhausted(): boolean;
}

export const idsFrom = (lists: Record<string, readonly string[]>): IdSequence => {
  const cursors = new Map<string, number>();
  const next = (prefix: string): string => {
    const list = lists[prefix] ?? [];
    const at = cursors.get(prefix) ?? 0;
    const value = list[at];
    if (value === undefined) {
      throw new Error(`planner fixture: id sequence "${prefix}" exhausted at ${at}`);
    }
    cursors.set(prefix, at + 1);
    return value;
  };
  return {
    updateId: () => next("u"),
    hlc: () => next("hlc"),
    newId: next,
    next,
    exhausted: () =>
      Object.entries(lists).every(([prefix, list]) => (cursors.get(prefix) ?? 0) === list.length),
  };
};

/** A counter-minting seam for generated batches, where no list is pinned. */
export const mintedIds = (): IdSequence => {
  const counters = new Map<string, number>();
  const tick = (prefix: string): number => {
    const count = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, count);
    return count;
  };
  const next = (prefix: string): string => `${prefix}_p${tick(prefix)}`;
  return {
    updateId: () => next("u"),
    hlc: () => String(111690000000000000n + BigInt(tick("hlc"))),
    newId: next,
    next,
    exhausted: () => true,
  };
};

export const fixtureNames = (): string[] =>
  readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json") && file !== "schema.json")
    .map((file) => file.slice(0, -".json".length))
    .sort();

export const loadFixture = (name: string): PlannerFixture =>
  JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8")) as PlannerFixture;

export const loadSpec = (name: string): SchemaSpec =>
  JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8")) as SchemaSpec;

/** A JSON serializer with sorted keys, so two structures compare byte for byte. */
export const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
