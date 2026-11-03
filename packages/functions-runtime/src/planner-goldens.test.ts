/**
 * The shared planner goldens, asserted from the runtime side.
 *
 * Each fixture pins a schema, an invocation id and actor, the id/HLC sequence
 * the planner consumes, a batch of semantic verb calls, and the core Action it
 * must produce. This suite applies the calls to a real `ctx` — through the
 * buffered write verbs and the one commit frame — and compares the submitted
 * Action to the pin. The client planner path asserts the same fixtures from
 * `@ebbjs/client`, so either path drifting turns a golden red.
 */

import { describe, expect, it } from "vitest";

import { actionIdForInvocation, createContext } from "./index.ts";
import { fakeHost } from "./test-support/host.ts";
import {
  applyVerb,
  fixtureNames,
  idsFrom,
  loadFixture,
  loadSpec,
  registryFrom,
  stable,
} from "./test-support/planner.ts";

describe("planner goldens — ctx path", () => {
  const names = fixtureNames();

  it("finds fixtures", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s submits the pinned Action through exactly one commit frame", async (name) => {
    const fixture = loadFixture(name);
    const ids = idsFrom(fixture.ids);
    const host = fakeHost();
    const ctx = createContext({
      transport: host.transport,
      invocationId: fixture.invocation_id,
      actor: { id: fixture.actor_id },
      caller: { kind: "actor", id: fixture.actor_id },
      registry: registryFrom(loadSpec(fixture.schema)),
      ids,
    });

    for (const verb of fixture.calls) await applyVerb(ctx, verb);
    await expect(ctx.commit()).resolves.toEqual({ replayed: false });

    expect(host.commits).toHaveLength(1);
    expect(stable(host.commits[0])).toBe(stable(fixture.action));
    expect(actionIdForInvocation(fixture.invocation_id)).toBe(fixture.action.id);
    expect(ids.exhausted()).toBe(true);
  });

  it.each(names)("%s consumes exactly the pinned ids and clock stamps", async (name) => {
    const fixture = loadFixture(name);
    // Running out of a pinned id throws, so committing with nothing left
    // proves both paths consume the same sequence in the same order.
    const ids = idsFrom(fixture.ids);
    const host = fakeHost();
    const ctx = createContext({
      transport: host.transport,
      invocationId: fixture.invocation_id,
      actor: { id: fixture.actor_id },
      caller: { kind: "actor", id: fixture.actor_id },
      registry: registryFrom(loadSpec(fixture.schema)),
      ids,
    });

    for (const verb of fixture.calls) await applyVerb(ctx, verb);
    await ctx.commit();

    expect(ids.exhausted()).toBe(true);
  });
});
