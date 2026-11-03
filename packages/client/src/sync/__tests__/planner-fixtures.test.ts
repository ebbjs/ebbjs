/**
 * The shared planner reference fixtures, asserted from the client side of the
 * extraction.
 *
 * Each fixture pins a schema, an invocation id and actor, the id/HLC sequence
 * the planner consumes, a batch of semantic verb calls, and the core Action it
 * must produce. This suite resolves those calls the way the client does — one
 * `commit(calls, capability)` batch through `@ebbjs/write` — and compares the
 * result to the pin, so the runtime's `ctx` path and the client's draft path
 * cannot drift apart without a reference fixture turning red.
 */

import { createHash } from "node:crypto";

import type { Update } from "@ebbjs/core";
import { commit, operationCallFor, type CommitCapability } from "@ebbjs/write";
import {
  fixtureNames,
  idsFrom,
  loadFixture,
  loadSpec,
  registryFrom,
  stable,
} from "@ebbjs/functions-protocol/testing";
import { describe, expect, it } from "vitest";

/** The same derivation the server and the runtime use, computed independently. */
const actionId = (invocationId: string): string =>
  `a_${createHash("sha256").update(invocationId, "utf8").digest("hex").slice(0, 16)}`;

describe("planner reference fixtures — client planner path", () => {
  const names = fixtureNames();

  it("finds fixtures", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s plans the pinned Action", async (name) => {
    const fixture = loadFixture(name);
    const registry = registryFrom(loadSpec(fixture.schema));
    const sequence = idsFrom(fixture.ids);

    const updates: Update[] = [];
    const capability: CommitCapability = {
      registry,
      actorId: fixture.actor_id,
      freshHlc: () => sequence.hlc(),
      generateUpdateId: () => sequence.updateId(),
      generateId: (prefix: string) => sequence.newId(prefix),
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
