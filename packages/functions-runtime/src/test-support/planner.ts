/**
 * Test support: replay a planner fixture through the runtime's write surface.
 *
 * The fixture format and its loader live in `@ebbjs/functions-protocol/testing`, because
 * the client-side fixture test reads the same files. This module adds the two
 * harnesses that are runtime-specific: the client planner path (a batch
 * commit) and the `ctx` path (the buffered verbs).
 */

import type { Update } from "@ebbjs/core";
import {
  call,
  commit,
  operationCallFor,
  type CommitCapability,
  type WriteVerb,
} from "@ebbjs/write";
import { registryFrom, type IdSequence } from "@ebbjs/functions-protocol/testing";

import type { Context } from "../index.ts";

export {
  fixtureNames,
  idsFrom,
  loadFixture,
  loadSpec,
  mintedIds,
  registryFrom,
  stable,
  type IdSequence,
  type PlannerFixture,
  type SchemaSpec,
} from "@ebbjs/functions-protocol/testing";

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
