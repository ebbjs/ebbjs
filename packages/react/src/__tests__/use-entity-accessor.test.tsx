/**
 * `useEntity` must re-read a row when one of its relationship accessors
 * changes, even though the row's own fields are unchanged. Without the
 * accessor subscription the hook's field-equality guard suppresses the
 * change and the accessor stays stale.
 */

import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  createClient,
  defineEntity,
  defineRelationship,
  defineSchema,
  e,
  type NamespacedClient,
} from "@ebbjs/client";
import { EbbProvider, useClient, useEntity } from "../index";

const todo = defineEntity("todo", { title: e.string() });
const user = defineEntity("user", { name: e.string() });

const schema = defineSchema({
  entities: { todo, user },
  relationships: { todo_owner: defineRelationship({ source: todo, target: user, as: "owner" }) },
  version: 1,
});

type Schema = typeof schema;
type Client = NamespacedClient<Schema>;

const mkEntity = (id: string, type: string, fields: Record<string, unknown>) => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

const mkRel = (id: string, sourceId: string, targetId: string) => ({
  id,
  type: "relationship",
  data: {
    fields: {
      source_id: { value: sourceId, update_id: "u" },
      target_id: { value: targetId, update_id: "u" },
      type: { value: "todo", update_id: "u" },
      field: { value: "owner", update_id: "u" },
    },
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

function OwnerProbe({ id }: { id: string }) {
  const client = useClient<Schema>();
  const row = useEntity(() => client.todo.get(id), [id]);
  const [ownerId, setOwnerId] = useState("none");

  useEffect(() => {
    let cancelled = false;
    if (row === null) {
      setOwnerId("none");
      return;
    }
    void (async () => {
      const owner = await row.owner;
      if (!cancelled) setOwnerId(owner == null ? "none" : owner.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [row]);

  return <span data-testid="owner">{ownerId}</span>;
}

const makeClient = (): Client =>
  createClient({ serverUrl: "http://localhost:4000", actorId: "test-actor", schema });

let seedPosition = 0;

/**
 * Write a relationship row to the shim and fold it into the replica the
 * accessors read (#520). A raw `storage.entities.set` only fires the change
 * emitter; the adjacency the accessor resolves through lives on the replica.
 */
const seedRelationship = async (client: Client, row: ReturnType<typeof mkRel>): Promise<void> => {
  await client.storage.entities.set(row);
  seedPosition += 1;
  const hlc = String(BigInt(seedPosition) << 16n);
  client.replica.ingest(
    {
      id: `a_seed_${seedPosition}`,
      actor_id: "seed",
      hlc,
      gsn: seedPosition,
      updates: [],
    },
    [
      {
        id: `u_seed_${seedPosition}`,
        subject_id: row.id,
        subject_type: row.type,
        method: "put",
        data: { fields: row.data.fields },
      },
    ],
    seedPosition,
  );
};

afterEach(cleanup);

describe("useEntity accessor reactivity", () => {
  it("re-reads the row when a relationship is linked, without a field change", async () => {
    const client = makeClient();
    await client.storage.entities.set(mkEntity("t1", "todo", { title: "T" }));
    await client.storage.entities.set(mkEntity("u1", "user", { name: "Ada" }));

    render(
      <EbbProvider client={client}>
        <OwnerProbe id="t1" />
      </EbbProvider>,
    );

    expect(await screen.findByText("none")).toBeTruthy();

    await act(async () => {
      await seedRelationship(client, mkRel("rel_1", "t1", "u1"));
    });

    expect(await screen.findByText("u1")).toBeTruthy();
  });
});
