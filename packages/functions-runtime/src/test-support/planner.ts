/**
 * Test support: the planner fixture format and the two harnesses that replay
 * it.
 *
 * A fixture pins the schema it needs, the invocation id and actor, the id/HLC
 * sequences the planner consumes, the semantic verb calls, and the core Action
 * both paths must produce. The client planner path resolves the calls through
 * `commit()` from `@ebbjs/write`; the runtime path applies them to a `ctx`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Type, type TSchema } from "@sinclair/typebox";
import type { Update } from "@ebbjs/core";
import {
  call,
  commit,
  operationCallFor,
  type CommitCapability,
  type OperationIds,
  type WriteVerb,
} from "@ebbjs/write";
import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/schema";

import type { Context } from "../index.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../fixtures/functions/planner/", import.meta.url),
);

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

const field = (spec: string) => {
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

/** Run one batch through the client planner path and return its Updates. */
export const planWithClient = async (
  registry: ReturnType<typeof registryFrom>,
  calls: readonly WriteVerb[],
  ids: IdSequence,
  actorId: string,
): Promise<Update[]> => {
  const updates: Update[] = [];
  const capability: CommitCapability = {
    registry,
    actorId,
    freshHlc: () => ids.hlc(),
    generateUpdateId: () => ids.next("u"),
    generateId: (prefix: string) => ids.next(prefix),
    submitRelationshipUpdates: async (batch) => {
      updates.push(...batch);
      return { rejected: [] };
    },
  };
  const planned = calls.flatMap((verb) => {
    const entry = operationCallFor(registry, verb);
    return entry === undefined ? [] : [call(entry.operation, entry.input)];
  });
  await commit(planned, capability);
  return updates;
};

const pointerOf = (value: string | { readonly id: string }) =>
  typeof value === "string" ? value : value.id;

/** Apply one semantic verb through the runtime's `ctx`. */
export const applyVerb = async (ctx: Context, verb: WriteVerb): Promise<void> => {
  switch (verb.verb) {
    case "create":
      ctx.create(
        verb.entity,
        { ...verb.fields },
        {
          id: verb.id,
          groups: verb.groups,
          validate: verb.validate,
        },
      );
      return;
    case "update":
      ctx.update(verb.entity, verb.id, { ...verb.patch }, { validate: verb.validate });
      return;
    case "delete":
      ctx.delete(verb.entity, verb.id);
      return;
    case "relate": {
      // A one-cardinality verb takes one target; a many-cardinality one takes
      // the whole FK set, which may be empty.
      const target =
        verb.targets !== undefined
          ? verb.targets.map(pointerOf)
          : verb.target === undefined
            ? []
            : pointerOf(verb.target);
      ctx.relate(verb.entity, verb.id, verb.as, target);
      return;
    }
    case "unrelate":
      await ctx.unrelate(
        verb.entity,
        verb.id,
        verb.as,
        verb.target === undefined ? undefined : pointerOf(verb.target),
        { relationshipId: verb.relationshipId },
      );
      return;
  }
};
