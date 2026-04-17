import { test, expect, beforeAll } from "vitest";
import { server } from "./setup";
import { seed } from "@ebbjs/server";
import { buildSingleEntitySeed } from "./seeds/single-entity";

beforeAll(async () => {
  await seed(server.url, "actor_test", buildSingleEntitySeed());
});

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
