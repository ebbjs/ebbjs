import { test, expect, beforeAll } from "vitest";
import { createClient } from "@ebbjs/client";
import { fixture, server } from "./setup";
import { seed } from "@ebbjs/testing";

beforeAll(async () => {
  await seed(server.url, fixture.actorId, fixture.seed);
}, 30000);

test("handshake returns group membership", async () => {
  const response = await fetch(`${server.url}/sync/handshake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ebb-actor-id": fixture.actorId,
    },
    body: JSON.stringify({ cursors: {} }),
  });

  const data = (await response.json()) as { actor_id: string; groups: Array<{ id: string }> };
  expect(data.actor_id).toBe(fixture.actorId);
  expect(data.groups).toContainEqual(expect.objectContaining({ id: fixture.groupId }));
});

/**
 * The seed's `patches: []` — a row with no components at all. Its existence is
 * the row's create, so the client's replica materializes a live, empty row
 * rather than nothing: this is the e2e job's coverage of the same fact
 * `row-create.test.ts` proves against the release (#817).
 */
test("the seeded zero-component row is a live row on the client replica", async () => {
  const client = createClient({ serverUrl: server.url, actorId: fixture.actorId });
  try {
    await client.handshake();
    await client.catchUp(fixture.groupId);

    const row = await client.readLocalEntity(fixture.entityId);
    expect(row).not.toBeNull();
    expect(row!.model).toBe(fixture.model);
    expect(row!.exists).toBe(true);
    expect(row!.data.fields).toEqual({});
    expect(row!.deleted_hlc).toBeNull();

    // The server's own row agrees on the creation time the create carried.
    // HLCs cross these JSON endpoints as numbers, so compare the value rather
    // than the digit string (JS cannot hold it exactly past 2^53).
    const wire = await client.getEntity(fixture.entityId);
    expect(wire).not.toBeNull();
    expect(wire!.data.fields).toEqual({});
    expect(Number(wire!.created_hlc)).toBe(Number(row!.created_hlc));
  } finally {
    client.close();
  }
});
