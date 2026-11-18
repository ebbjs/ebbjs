/**
 * Integration: the row-scoped create (#817) against a real ebb_server.
 *
 * The ADR's row-create amendment
 * (`docs/adr/0001-component-model.md`) is the contract this file proves end to
 * end; [#817](https://github.com/ebbjs/ebbjs/issues/817) carried the acceptance
 * list. A row's existence is an explicit, row-scoped Update —
 * `{ id, subject_id, model, method: "create", hlc, data: null }` — so a
 * zero-component row is a legal row, a component write never implies
 * existence, and `created_hlc` is the create's own HLC on every delivery path
 * (live write, catch-up, listing seed, content backfill).
 *
 * The model these tests create is declared here, not in a production schema:
 * every component is `optional: true`, so `create({})` is a complete row.
 *
 * ## Skip semantics
 *
 * The reachability gate lives in `./server`: `itIfServer` reports a test as
 * skipped when no server answers at `EBB_TEST_URL` (default
 * `localhost:4000`), so a plain `pnpm test` stays green without a server.
 *
 * ## Isolation
 *
 * One group, one schema, and one actor per test, all named with a per-run
 * suffix, so the file is reentrant against the same server.
 */

import { beforeAll, describe, expect } from "vitest";
import {
  componentName,
  createAction,
  createClock,
  decodeSync,
  encodeSync,
  localEvent,
  type Action,
  type RowCreate,
} from "@ebbjs/core";
import { defineComponent, defineModel, defineSchema, e } from "@ebbjs/schema";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { membershipRowId } from "@ebbjs/write";
import { createClient, defineAction } from "../..";
import { createGroupListing, LISTING_SEED_ACTOR_ID } from "../../sync/group-listing";
import { itIfServer, runId, SERVER_URL, serverReachable } from "./server";

/** Unique per run so the suite is reentrant against the same server. */
const RUN_ID = runId();
const GROUP_ID = `grp_row_create_${RUN_ID}`;
const SEEDER_ACTOR_ID = `rc_seeder_${RUN_ID}`;

/** The actor each test writes as; a fresh one keeps the tests independent. */
const WRITER = `rc_writer_${RUN_ID}`;
const TAILER = `rc_tailer_${RUN_ID}`;
const LISTENER = `rc_listener_${RUN_ID}`;
const DROPPER = `rc_dropper_${RUN_ID}`;
const BACKFILLER = `rc_backfiller_${RUN_ID}`;
const DUPLICATOR = `rc_duplicator_${RUN_ID}`;

const MEMBER_PERMISSIONS = [
  "note.*",
  "ebb/group.*",
  "ebb/grant.*",
  "ebb/membership.*",
  "ebb/link.*",
] as const;

/**
 * `note` is the model under test: both components are optional, so the row's
 * create alone is a complete row and a component write is never what makes it
 * exist.
 */
const note = defineModel("note", {
  title: defineComponent("note/title", e.string(), { optional: true }),
  body: defineComponent("note/body", e.string(), { optional: true }),
});

const schema = defineSchema({ models: { note }, version: 1 });

/** `client.create({})` — a zero-component create emitted by the write planner. */
const createEmptyNote = defineAction(schema, ({ note: notes }) =>
  notes.create({}, { groups: [GROUP_ID] }),
);

const createTitledNote = defineAction(schema, ({ note: notes }, params: { title: string }) =>
  notes.create({ title: params.title }, { groups: [GROUP_ID] }),
);

const patchTitle = defineAction(
  schema,
  ({ note: notes }, params: { id: string; title: string }) => {
    notes.update(params.id, { title: params.title });
  },
);

/** Drop the row's only component. */
const dropTitle = defineAction(schema, ({ note: notes }, params: { id: string }) => {
  notes.drop(params.id, ["title"]);
});

const noteActions = { createEmptyNote, createTitledNote, patchTitle, dropTitle };

/** A client with no schema: the fixture seeder only needs the public write path. */
const createSeeder = () => createClient({ serverUrl: SERVER_URL, actorId: SEEDER_ACTOR_ID });

/** The test group, its schema seeder, and one member per test. */
beforeAll(async () => {
  if (!serverReachable) return;

  const seeder = createSeeder();
  try {
    // The bootstrap Action: the group's create, then the seeder's own grant.
    await seeder.seed({
      groups: [{ id: GROUP_ID, name: `Row create ${RUN_ID}` }],
      grants: [
        {
          id: `gm_${RUN_ID}_seeder`,
          actorId: SEEDER_ACTOR_ID,
          groupId: GROUP_ID,
          permissions: [...MEMBER_PERMISSIONS],
        },
      ],
      entities: [],
    });
    // Every test's actor, granted after the bootstrap (a normal grant write).
    await seeder.seed({
      groups: [],
      grants: [WRITER, TAILER, LISTENER, DROPPER, BACKFILLER, DUPLICATOR].map((actorId) => ({
        id: `gm_${RUN_ID}_${actorId}`,
        actorId,
        groupId: GROUP_ID,
        permissions: [...MEMBER_PERMISSIONS],
      })),
      entities: [],
    });
  } finally {
    seeder.close();
  }
}, 30_000);

/** A client carrying the test schema and the draft actions above. */
const createRowClient = (actorId: string, fetchImpl?: typeof fetch) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId,
    schema,
    actions: noteActions,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });

type RowClient = ReturnType<typeof createRowClient>;

/** Handshake as `actorId` and land in the test group. */
async function connectAs(actorId: string, fetchImpl?: typeof fetch): Promise<RowClient> {
  const client = createRowClient(actorId, fetchImpl);
  const { groups } = await client.handshake();
  if (!groups.some((group) => group.id === GROUP_ID)) {
    throw new Error(`actor ${actorId} did not join ${GROUP_ID}`);
  }
  client.setState("live");
  return client;
}

/** Drive `catchUp` until the server reports `upToDate`. */
async function catchUpUntilCurrent(client: RowClient): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { upToDate } = await client.catchUp(GROUP_ID);
    if (upToDate) return;
  }
  throw new Error(`catchUpUntilCurrent: exhausted retries for group ${GROUP_ID}`);
}

/** The server's log for the test group, oldest first (`GET /sync/groups/:id`). */
async function fetchActions(): Promise<readonly Action[]> {
  const res = await fetch(`${SERVER_URL}/sync/groups/${GROUP_ID}?offset=0`, {
    headers: { "x-ebb-actor-id": SEEDER_ACTOR_ID },
  });
  if (!res.ok) throw new Error(`fetchActions failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Action[];
}

/** The row's create across a set of Actions, or `undefined` if none carries one. */
const createOf = (actions: readonly Action[], subjectId: string): RowCreate | undefined => {
  for (const action of actions) {
    for (const update of action.updates) {
      if (update.method === "create" && update.subject_id === subjectId) return update;
    }
  }
  return undefined;
};

/** Post one hand-built Action, returning the server's rejections. */
async function postAction(
  actorId: string,
  action: Action,
): Promise<readonly { readonly id: string; readonly reason: string }[]> {
  const res = await fetch(`${SERVER_URL}/sync/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/msgpack", "x-ebb-actor-id": actorId },
    body: encodeSync({ actions: [action] }) as BodyInit,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /sync/actions failed: ${res.status} ${text}`);
  if (text === "") return [];
  const body = JSON.parse(text) as { rejected?: readonly { id: string; reason: string }[] };
  return body.rejected ?? [];
}

/** The server's JSON row: `created_hlc` arrives as a number (see `hlcValue`). */
interface ServerRow {
  readonly id: string;
  readonly model: string;
  readonly data: { readonly fields: Record<string, unknown> };
  readonly created_hlc: number | string;
  readonly deleted_hlc: number | string | null;
}

/** `GET /entities/:id` — the server's own view of a row. */
async function serverRow(id: string): Promise<ServerRow | null> {
  const res = await fetch(`${SERVER_URL}/entities/${encodeURIComponent(id)}`, {
    headers: { "x-ebb-actor-id": SEEDER_ACTOR_ID },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /entities/${id} failed: ${res.status}`);
  return (await res.json()) as ServerRow;
}

/**
 * An HLC as a comparable value.
 *
 * The server's JSON endpoints (`/entities/:id`, catch-up) carry HLCs as
 * numbers, which JS cannot hold exactly past 2^53, so two spellings of the
 * same creation time can differ in their last digits. Compare the value the
 * transport preserves; the msgpack write path is compared the same way.
 */
const hlcValue = (hlc: number | string | null | undefined): number | null =>
  hlc === null || hlc === undefined ? null : Number(hlc);

/** One wire Update that names a component value. */
const componentWrite = (
  subjectId: string,
  model: string,
  field: string,
  value: unknown,
  hlc: string,
): Action["updates"][number] => ({
  id: `u_${subjectId}_${field}`,
  subject_id: subjectId,
  component: componentName(model, field),
  method: "replace",
  data: { value, update_id: `u_${subjectId}_${field}`, hlc },
});

describe("integration: the row-scoped create (#817)", () => {
  itIfServer("client.create({}) round-trips as a live row with no fields", async () => {
    // Record the wire Action so the assertions can name the create's own HLC.
    const written: Action[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/sync/actions") && init?.body instanceof Uint8Array) {
        written.push(...decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return fetch(input, init);
    };

    const client = await connectAs(WRITER, recordingFetch);
    try {
      const handle = await client.actions.createEmptyNote();
      const id = handle.id;

      // A zero-component create is one Update on the wire, and it is the only
      // Update naming this row.
      const rowUpdates = written
        .flatMap((action) => action.updates)
        .filter((update) => update.subject_id === id);
      expect(rowUpdates).toHaveLength(1);
      const create = rowUpdates[0]!;
      expect(create).toMatchObject({ method: "create", model: "note", data: null });
      if (create.method !== "create") throw new Error("expected the row's create");
      expect(create.hlc).toBeTruthy();

      // The server materialized the row: it is live, empty, and dated by the
      // create's HLC.
      const wire = await serverRow(id);
      expect(wire).not.toBeNull();
      expect(wire!.model).toBe("note");
      expect(wire!.data.fields).toEqual({});
      expect(hlcValue(wire!.created_hlc)).toBe(hlcValue(create.hlc));

      // The local replica agrees, and it is a live row rather than a
      // placeholder: only the create sets `exists`.
      const row = await client.readLocalEntity(id);
      expect(row).not.toBeNull();
      expect(row!.exists).toBe(true);
      expect(row!.model).toBe("note");
      expect(row!.data.fields).toEqual({});
      expect(hlcValue(row!.created_hlc)).toBe(hlcValue(create.hlc));
      expect(row!.deleted_hlc).toBeNull();
      for (const component of ["title", "body"]) {
        expect(row!.data.fields).not.toHaveProperty(component);
      }

      // Its own echo changes nothing: the create is idempotent on replay.
      await catchUpUntilCurrent(client);
      const settled = await client.readLocalEntity(id);
      expect(hlcValue(settled!.created_hlc)).toBe(hlcValue(create.hlc));
      expect(settled!.data.fields).toEqual({});
      expect(settled!.exists).toBe(true);
    } finally {
      client.close();
    }
  });

  itIfServer("a zero-component row reaches a cold replica through catch-up", async () => {
    const writer = await connectAs(WRITER);
    let id: string;
    let createdHlc: number | null;
    try {
      const handle = await writer.actions.createEmptyNote();
      id = handle.id;
      await catchUpUntilCurrent(writer);
      createdHlc = hlcValue((await serverRow(id))!.created_hlc);
    } finally {
      writer.close();
    }

    // A replica that only tails: no handshake, no listing seed, no content
    // backfill — just the group's Actions, from the beginning.
    const tailer = createClient({ serverUrl: SERVER_URL, actorId: TAILER, schema });
    try {
      await tailer.catchUp(GROUP_ID);
      const applied = await tailer.storage.actions.getAll();
      expect(applied.some((action) => action.actor_id === LISTING_SEED_ACTOR_ID)).toBe(false);

      const row = await tailer.readLocalEntity(id);
      expect(row).not.toBeNull();
      expect(row!.exists).toBe(true);
      expect(row!.data.fields).toEqual({});
      expect(hlcValue(row!.created_hlc)).toBe(createdHlc);
    } finally {
      tailer.close();
    }
  });

  itIfServer(
    "a cold replica's listing seed materializes the zero-component row when delivery missed the create",
    async () => {
      const writer = await connectAs(WRITER);
      let id: string;
      let createdHlc: number | null;
      try {
        const handle = await writer.actions.createEmptyNote();
        id = handle.id;
        await catchUpUntilCurrent(writer);
        createdHlc = hlcValue((await serverRow(id))!.created_hlc);
      } finally {
        writer.close();
      }

      // The listener subscribes to a group it has never synced. The seed pins
      // the group's cursor at the listing watermark, so the create (older than
      // that watermark) never arrives through the tail: the base is the listing.
      const listener = createClient({ serverUrl: SERVER_URL, actorId: LISTENER, schema });
      const unsubscribe = listener.subscribe([GROUP_ID], () => undefined);
      try {
        await expect
          .poll(async () => (await listener.readLocalEntity(id))?.exists ?? false, {
            timeout: 20_000,
          })
          .toBe(true);

        const seeded = (await listener.storage.actions.getAll()).find(
          (action) =>
            action.actor_id === LISTING_SEED_ACTOR_ID &&
            action.updates.some((update) => update.subject_id === id),
        );
        expect(seeded).toBeDefined();
        const seedCreate = createOf([seeded!], id);
        expect(seedCreate).toMatchObject({ model: "note", method: "create", data: null });

        const row = await listener.readLocalEntity(id);
        expect(row!.data.fields).toEqual({});
        expect(hlcValue(row!.created_hlc)).toBe(createdHlc);
      } finally {
        unsubscribe();
        listener.close();
      }
    },
  );

  itIfServer(
    "dropping the last component leaves a live row with no fields on a fresh replica",
    async () => {
      const writer = await connectAs(DROPPER);
      let id: string;
      let createdHlc: number | null;
      try {
        const handle = await writer.actions.createTitledNote({ title: "only field" });
        id = handle.id;
        await catchUpUntilCurrent(writer);
        createdHlc = hlcValue((await serverRow(id))!.created_hlc);

        await writer.actions.dropTitle({ id });
        await catchUpUntilCurrent(writer);

        const afterDrop = await writer.readLocalEntity(id);
        expect(afterDrop!.data.fields).toEqual({});
        expect(afterDrop!.exists).toBe(true);
      } finally {
        writer.close();
      }

      // The server still holds the row, with no components.
      const wire = await serverRow(id);
      expect(wire).not.toBeNull();
      expect(wire!.data.fields).toEqual({});
      expect(hlcValue(wire!.created_hlc)).toBe(createdHlc);

      // A fresh replica folds create → drop and returns the row, not `null`.
      const fresh = createClient({ serverUrl: SERVER_URL, actorId: TAILER, schema });
      try {
        await fresh.catchUp(GROUP_ID);
        const row = await fresh.readLocalEntity(id);
        expect(row).not.toBeNull();
        expect(row!.exists).toBe(true);
        expect(row!.data.fields).toEqual({});
        expect(hlcValue(row!.created_hlc)).toBe(createdHlc);
        expect(row!.deleted_hlc).toBeNull();
      } finally {
        fresh.close();
      }
    },
  );

  itIfServer(
    "created_hlc is the create's HLC on a replica whose first delivered write was a component write and whose base came from backfill",
    async () => {
      const writer = await connectAs(BACKFILLER);
      let id: string;
      let createdHlc: number | null;
      let createGsn: number;
      try {
        const handle = await writer.actions.createTitledNote({ title: "first" });
        id = handle.id;
        await catchUpUntilCurrent(writer);
        createdHlc = hlcValue((await serverRow(id))!.created_hlc);

        const createAction = (await fetchActions()).find((action) =>
          action.updates.some((update) => update.method === "create" && update.subject_id === id),
        );
        expect(createAction).toBeDefined();
        createGsn = createAction!.gsn;
        expect(createGsn).toBeGreaterThan(0);

        // The reference the backfill pass needs, re-put after the create: a
        // replica whose cursor starts past the create still learns the row is
        // in the group. The membership row's own create is a duplicate and is a
        // no-op, which is exactly the row-create contract.
        const seeder = createSeeder();
        try {
          await seeder.seed({
            groups: [],
            grants: [],
            entities: [],
            memberships: [{ id: membershipRowId(id, GROUP_ID), entityId: id, groupId: GROUP_ID }],
          });
        } finally {
          seeder.close();
        }

        // The component write that reaches the replica first.
        await writer.actions.patchTitle({ id, title: "second" });
        await catchUpUntilCurrent(writer);
      } finally {
        writer.close();
      }

      const replica = createClient({ serverUrl: SERVER_URL, actorId: BACKFILLER, schema });
      try {
        // Past the create: the first delivered write for the row is the title.
        await replica.catchUp(GROUP_ID, createGsn);

        const placeholder = await replica.readLocalEntity(id);
        expect(placeholder).not.toBeNull();
        expect(placeholder!.exists).toBe(false);
        expect(placeholder!.created_hlc).toBeNull();
        expect(placeholder!.data.fields.title?.value).toBe("second");

        await replica.backfill();

        const row = await replica.readLocalEntity(id);
        expect(row).not.toBeNull();
        expect(row!.exists).toBe(true);
        // The base is stamped at the row's latest position; the creation time
        // comes from the create the base carries, not from the snapshot.
        expect(hlcValue(row!.created_hlc)).toBe(createdHlc);
        expect(row!.data.fields.title?.value).toBe("second");
      } finally {
        replica.close();
      }
    },
  );

  itIfServer("a duplicate create changes nothing", async () => {
    const writer = await connectAs(DUPLICATOR);
    let id: string;
    let createdHlc: number | null;
    try {
      const handle = await writer.actions.createEmptyNote();
      id = handle.id;
      await catchUpUntilCurrent(writer);
      createdHlc = hlcValue((await serverRow(id))!.created_hlc);
    } finally {
      writer.close();
    }

    // A second create for a row the server already holds: a fresh seed row
    // with the same id and no components.
    const seeder = createSeeder();
    try {
      await seeder.seed({
        groups: [],
        grants: [],
        entities: [{ id, model: "note", patches: [] }],
      });
    } finally {
      seeder.close();
    }

    const wire = await serverRow(id);
    expect(wire).not.toBeNull();
    expect(hlcValue(wire!.created_hlc)).toBe(createdHlc);
    expect(wire!.data.fields).toEqual({});

    // A listing seed of an already-known row: the redo replays the same
    // deterministic seed Action, and the row's existence and creation time
    // are unchanged.
    const storage = createMemoryAdapter();
    const listing = createGroupListing({
      serverUrl: SERVER_URL,
      actorId: SEEDER_ACTOR_ID,
      fetchImpl: fetch,
      storage,
    });
    await listing.bootstrap(GROUP_ID);
    const first = await storage.entities.get(id);
    expect(first).toMatchObject({ exists: true, model: "note", data: { fields: {} } });
    expect(hlcValue(first!.created_hlc)).toBe(createdHlc);

    // A crash left the resume marker behind: the redo lists the group again.
    await storage.cursors.setRecord(GROUP_ID, { seed: { group_id: GROUP_ID } });
    await listing.bootstrap(GROUP_ID);

    const second = await storage.entities.get(id);
    expect(second).toMatchObject({ exists: true, model: "note", data: { fields: {} } });
    expect(hlcValue(second!.created_hlc)).toBe(createdHlc);
    const seedIds = (await storage.actions.getAll())
      .filter((action) => action.updates.some((update) => update.subject_id === id))
      .map((action) => action.id);
    expect(new Set(seedIds).size).toBe(1);
  });

  itIfServer("the server refuses a component write for a row it has no create for", async () => {
    const clock = createClock();
    const hlc = localEvent(clock);
    const orphanId = `note_orphan_${RUN_ID}`;
    const { action } = createAction({
      actorId: SEEDER_ACTOR_ID,
      clock,
      updates: [componentWrite(orphanId, "note", "title", "orphan", hlc)],
    });

    const rejected = await postAction(SEEDER_ACTOR_ID, action);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe(action.id);

    // A component write never invents a row.
    expect(await serverRow(orphanId)).toBeNull();
  });
});
