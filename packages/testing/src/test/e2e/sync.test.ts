import { test, expect, beforeAll } from "vitest";
import { createClient } from "@ebbjs/client";
import { server } from "./setup";
import { seed } from "@ebbjs/testing";
import { buildSingleEntitySeed } from "./seeds/single-entity";

beforeAll(async () => {
  await seed(server.url, "actor_test", buildSingleEntitySeed());
}, 30000);

test("handshake returns group membership", async () => {
  const response = await fetch(`${server.url}/sync/handshake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ebb-actor-id": "actor_test",
    },
    body: JSON.stringify({ cursors: {} }),
  });

  const data = (await response.json()) as { actor_id: string; groups: Array<{ id: string }> };
  expect(data.actor_id).toBe("actor_test");
  expect(data.groups).toContainEqual(expect.objectContaining({ id: "grp_001" }));
});

/**
 * The seed's `ent_001` is `patches: []` — a row with no components at all.
 * Its existence is the row's create, so the client's replica materializes a
 * live, empty row rather than nothing: this is the e2e job's coverage of the
 * same fact `row-create.test.ts` proves against the release (#817).
 */
test("the seeded zero-component row is a live row on the client replica", async () => {
  const client = createClient({ serverUrl: server.url, actorId: "actor_test" });
  try {
    await client.handshake();
    await client.catchUp("grp_001");

    const row = await client.readLocalEntity("ent_001");
    expect(row).not.toBeNull();
    expect(row!.model).toBe("text_document");
    expect(row!.exists).toBe(true);
    expect(row!.data.fields).toEqual({});
    expect(row!.deleted_hlc).toBeNull();

    // The server's own row agrees on the creation time the create carried.
    // HLCs cross these JSON endpoints as numbers, so compare the value rather
    // than the digit string (JS cannot hold it exactly past 2^53).
    const wire = await client.getEntity("ent_001");
    expect(wire).not.toBeNull();
    expect(wire!.data.fields).toEqual({});
    expect(Number(wire!.created_hlc)).toBe(Number(row!.created_hlc));
  } finally {
    client.close();
  }
});
