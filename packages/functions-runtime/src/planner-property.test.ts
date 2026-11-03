/**
 * The property test the reference fixtures cannot cover: a seeded PRNG generates random
 * verb batches from the same vocabulary, and both planner paths — `commit()`
 * from `@ebbjs/write` (what the client runs) and the runtime's `ctx` — must
 * produce the same Updates and the same full Action.
 *
 * The generator covers what the writer decides: multi-entity batches, rows
 * created and then patched, related, or deleted in the same batch, and both
 * relationship cardinalities.
 */

import { describe, expect, it } from "vitest";

import type { WriteVerb } from "@ebbjs/write";

import { actionIdForInvocation, createContext } from "./index.ts";
import {
  applyVerb,
  loadSpec,
  mintedIds,
  planWithClient,
  registryFrom,
  stable,
} from "./test-support/planner.ts";

/** A small, fast PRNG so a failure names a seed rather than a wall-clock run. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Rows the generator treats as already stored. */
const STORED = ["e_stored1", "e_stored2"] as const;
const PROJECTS = ["e_project1", "e_project2"] as const;
const LABELS = ["e_label1", "e_label2", "e_label3"] as const;
const GROUPS = ["g_alpha", "g_beta"] as const;

const pick = <T>(rng: () => number, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)] as T;

/** Generate one batch of 2–7 verbs over the fixture schema. */
const generateBatch = (rng: () => number): WriteVerb[] => {
  const verbs: WriteVerb[] = [];
  const created: string[] = [];
  let minted = 0;

  const target = (): string =>
    created.length > 0 && rng() < 0.5 ? pick(rng, created) : pick(rng, STORED);

  const count = 2 + Math.floor(rng() * 6);
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    if (roll < 0.25) {
      const id = `e_generated${(minted += 1)}`;
      created.push(id);
      verbs.push({
        verb: "create",
        entity: "issue",
        id,
        fields: {
          title: `title-${minted}`,
          done: rng() < 0.5,
          ...(rng() < 0.5 ? { project: pick(rng, PROJECTS) } : {}),
          labels: rng() < 0.5 ? [pick(rng, LABELS)] : [],
        },
        groups: rng() < 0.5 ? [GROUPS[0]] : [GROUPS[0], GROUPS[1]],
      });
      continue;
    }
    if (roll < 0.45) {
      verbs.push({
        verb: "update",
        entity: "issue",
        id: target(),
        patch: rng() < 0.5 ? { title: `revised-${i}` } : { done: true },
      });
      continue;
    }
    if (roll < 0.55) {
      verbs.push({ verb: "delete", entity: "issue", id: target() });
      continue;
    }
    if (roll < 0.75) {
      verbs.push({
        verb: "relate",
        entity: "issue",
        id: target(),
        as: "project",
        target: pick(rng, PROJECTS),
      });
      continue;
    }
    if (roll < 0.87) {
      const targets = rng() < 0.5 ? [] : [pick(rng, LABELS)];
      if (rng() < 0.5) targets.push(pick(rng, LABELS));
      verbs.push({ verb: "relate", entity: "issue", id: target(), as: "labels", targets });
      continue;
    }
    if (roll < 0.94) {
      verbs.push({
        verb: "unrelate",
        entity: "issue",
        id: target(),
        as: "project",
        // A stored edge has no row id the invocation can read, so the caller
        // names it — the documented v1 path.
        relationshipId: `rel_stored${i}`,
      });
      continue;
    }
    verbs.push({ verb: "unrelate", entity: "issue", id: target(), as: "labels" });
  }

  return verbs;
};

const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1);

describe("planner property: client planner and ctx agree", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const verbs = generateBatch(mulberry32(seed));
    const registry = registryFrom(loadSpec("schema"));
    const invocationId = `inv_prop${seed}`;
    const actorId = "a_property";

    const clientIds = mintedIds();
    const updates = await planWithClient(registry, verbs, clientIds, actorId);
    const expected = {
      id: actionIdForInvocation(invocationId),
      actor_id: actorId,
      hlc: clientIds.hlc(),
      gsn: 0,
      updates,
    };

    const commits: unknown[] = [];
    const ctx = createContext({
      transport: {
        call: async (op, payload) => {
          if (op !== "commit") return null;
          commits.push(payload);
          return { replayed: false };
        },
      },
      invocationId,
      actor: { id: actorId },
      caller: { kind: "actor", id: actorId },
      registry,
      ids: mintedIds(),
    });

    for (const verb of verbs) await applyVerb(ctx, verb);
    await ctx.commit();

    expect(commits).toHaveLength(1);
    expect(stable(commits[0])).toBe(stable(expected));
  });

  it("generates batches with creates, patches, deletes, and both cardinalities", () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      for (const verb of generateBatch(mulberry32(seed))) kinds.add(verb.verb);
    }
    expect([...kinds].sort()).toEqual(["create", "delete", "relate", "unrelate", "update"]);

    const refersToCreated = SEEDS.some((seed) =>
      generateBatch(mulberry32(seed)).some(
        (verb) => verb.verb !== "create" && verb.id.startsWith("e_generated"),
      ),
    );
    expect(refersToCreated).toBe(true);
  });
});
