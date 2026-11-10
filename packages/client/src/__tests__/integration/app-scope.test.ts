/**
 * Two apps, one actor, one store (#732 acceptance).
 *
 * Each client declares a local `appId`; the handshake keeps only the
 * groups whose `apps` map names it (plus unscoped groups). A bridge
 * group names both apps, and an entity filed into it is delivered to
 * both replicas. Scope is a residency filter, not authority: both apps
 * write as the same actor, and the actor's grants decide what lands.
 *
 * Follows the directory's ping/skip convention: every `it` short-circuits
 * when no server answers at `EBB_TEST_URL` (default localhost:4000), so
 * `pnpm test` stays green without one.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAction, createClock, localEvent } from "@ebbjs/core";
import { defineModel, defineSchema, e } from "@ebbjs/schema";
import { createClient, defineAction, type SyncClient } from "../..";

const SERVER_URL = process.env.EBB_TEST_URL ?? "http://localhost:4000";

/** Unique per run so the suite is reentrant against the same server. */
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ALICE = `app_scope_alice_${RUN_ID}`;
const G_NOTES = `grp_notes_${RUN_ID}`;
const G_ISSUES = `grp_issues_${RUN_ID}`;
const G_BRIDGE = `grp_bridge_${RUN_ID}`;
const G_SHARED = `grp_shared_${RUN_ID}`;
const NOTE = `note_${RUN_ID}`;

/**
 * Permissions Alice holds in her own groups. The bridge membership uses the
 * same list: covering both types is what makes bidirectional edits legal (D6).
 */
const MEMBER_PERMISSIONS = ["group.*", "groupMember.*", "entityGroup.*", "note.*", "issue.*"];

/** A schema-bearing client: `group.update` needs the map marker to write scope. */
const note = defineModel("note", { title: e.string() });
const appScopeSchema = defineSchema({ models: { note }, version: 1 });
const appScopeActions = {
  setScope: defineAction(
    appScopeSchema,
    ({ group }, params: { id: string; apps: Record<string, boolean> }) => {
      group.update(params.id, { apps: params.apps });
    },
  ),
};

const createAppScopeClient = (appId: string) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ALICE,
    appId,
    schema: appScopeSchema,
    actions: appScopeActions,
  });

let notes: ReturnType<typeof createAppScopeClient> | null = null;
let issues: ReturnType<typeof createAppScopeClient> | null = null;
let plain: SyncClient | null = null;
let stopIssues: (() => void) | null = null;
let reachable = false;

const ping = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${SERVER_URL}/sync/handshake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": ALICE },
      body: "{}",
    });
    return res.status < 500;
  } catch {
    return false;
  }
};

const leaf = (value: unknown, updateId: string, clock: ReturnType<typeof createClock>) => ({
  value,
  update_id: updateId,
  hlc: localEvent(clock),
});

const notePatch = (title: string) => {
  const clock = createClock();
  const updateId = `u_note_${RUN_ID}_${title.replace(/\W/g, "")}`;
  return createAction({
    actorId: ALICE,
    clock,
    updates: [
      {
        id: `${updateId}_0`,
        subject_id: NOTE,
        component: "note/title",
        method: "merge",
        data: leaf(title, updateId, clock),
      },
    ],
  }).action;
};

const fileInto = (entityId: string, groupId: string) => {
  const clock = createClock();
  const updateId = `u_share_${RUN_ID}`;
  return createAction({
    actorId: ALICE,
    clock,
    updates: [
      {
        id: `${updateId}_0`,
        subject_id: `eg_${RUN_ID}_${groupId}_${entityId}`,
        component: "entityGroup/entity_id",
        method: "replace",
        data: leaf(entityId, updateId, clock),
      },
      {
        id: `${updateId}_1`,
        subject_id: `eg_${RUN_ID}_${groupId}_${entityId}`,
        component: "entityGroup/group_id",
        method: "replace",
        data: leaf(groupId, updateId, clock),
      },
    ],
  }).action;
};

const handshakeIds = async (client: SyncClient): Promise<string[]> => {
  const { groups } = await client.handshake();
  return groups.map((group) => group.id);
};

/** The projected title of a local replica row, or undefined when absent. */
const titleOf = (client: SyncClient): unknown => {
  const row = client.replica.get(NOTE);
  return row?.data.fields?.["title"]?.value;
};

beforeAll(async () => {
  reachable = await ping();
  if (!reachable) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  // A plain client creates an unscoped group: absent scope means every app.
  plain = createClient({ serverUrl: SERVER_URL, actorId: ALICE });
  await plain.seed({
    groups: [{ id: G_SHARED, name: "Shared" }],
    groupMembers: [
      {
        id: `gm_shared_${RUN_ID}`,
        actorId: ALICE,
        groupId: G_SHARED,
        permissions: MEMBER_PERMISSIONS,
      },
    ],
    entities: [],
  });

  // `seed()` scopes an explicit-less group to the seeding client's app, so
  // each group carries the app that created it without an extra Update.
  notes = createAppScopeClient("notes");
  await notes.seed({
    groups: [{ id: G_NOTES, name: "Notes" }],
    groupMembers: [
      {
        id: `gm_notes_${RUN_ID}`,
        actorId: ALICE,
        groupId: G_NOTES,
        permissions: MEMBER_PERMISSIONS,
      },
    ],
    entities: [{ id: NOTE, type: "note", patches: [{ fields: { title: "Draft" } }] }],
    entityGroups: [{ id: `eg_${RUN_ID}_${NOTE}`, entityId: NOTE, groupId: G_NOTES }],
  });

  issues = createAppScopeClient("issues");
  await issues.seed({
    groups: [{ id: G_ISSUES, name: "Issues", apps: { issues: true } }],
    groupMembers: [
      {
        id: `gm_issues_${RUN_ID}`,
        actorId: ALICE,
        groupId: G_ISSUES,
        permissions: MEMBER_PERMISSIONS,
      },
    ],
    entities: [],
  });

  // The bridge names both apps; one Action bootstraps it and its membership.
  await notes.seed({
    groups: [{ id: G_BRIDGE, name: "Bridge", apps: { notes: true, issues: true } }],
    groupMembers: [
      {
        id: `gm_bridge_${RUN_ID}`,
        actorId: ALICE,
        groupId: G_BRIDGE,
        permissions: MEMBER_PERMISSIONS,
      },
    ],
    entities: [],
  });
});

afterAll(() => {
  stopIssues?.();
  notes?.close();
  issues?.close();
  plain?.close();
});

describe("app scope integration", () => {
  it("isolates each app's replica and keeps unscoped groups everywhere", async () => {
    if (!reachable) return;

    const notesIds = await handshakeIds(notes!);
    expect(notesIds).toContain(G_NOTES);
    expect(notesIds).toContain(G_BRIDGE);
    expect(notesIds).toContain(G_SHARED);
    expect(notesIds).not.toContain(G_ISSUES);

    const issuesIds = await handshakeIds(issues!);
    expect(issuesIds).toContain(G_ISSUES);
    expect(issuesIds).toContain(G_BRIDGE);
    expect(issuesIds).toContain(G_SHARED);
    expect(issuesIds).not.toContain(G_NOTES);
  });

  it("delivers a shared entity to both apps and converges edits both ways", async () => {
    if (!reachable) return;

    await handshakeIds(notes!);
    await handshakeIds(issues!);

    // Notes files its note into the bridge (the share is an entityGroup put).
    expect((await notes!.write([fileInto(NOTE, G_BRIDGE)])).rejected).toEqual([]);

    // The issues replica learns the note through the bridge listing.
    stopIssues = issues!.subscribe([G_ISSUES, G_BRIDGE, G_SHARED], () => undefined);
    await expect.poll(() => issues!.replica.get(NOTE), { timeout: 10_000 }).toBeDefined();
    // The flush gate holds writes until the subscription's catch-up ends.
    await expect.poll(() => issues!.state, { timeout: 10_000 }).toBe("live");

    // Issues edits the note; notes sees it through its own group.
    expect((await issues!.write([notePatch("Edited by issues")])).rejected).toEqual([]);
    await notes!.catchUp(G_NOTES);
    expect(titleOf(notes!)).toBe("Edited by issues");

    // Notes edits back; issues catches up on the bridge.
    expect((await notes!.write([notePatch("Edited by notes")])).rejected).toEqual([]);
    await issues!.catchUp(G_BRIDGE);
    expect(titleOf(issues!)).toBe("Edited by notes");
  });

  it("removes a group from the app on the next reconcile when its scope says false", async () => {
    if (!reachable) return;

    await handshakeIds(notes!);
    // The SDK path: a `group.update` map patch, not a hand-rolled envelope.
    await notes!.actions.setScope({ id: G_BRIDGE, apps: { issues: false } });

    const issuesIds = await handshakeIds(issues!);
    expect(issuesIds).not.toContain(G_BRIDGE);
    expect(issuesIds).toContain(G_ISSUES);

    // The bridge's note is evicted from the issues replica with the group.
    await expect.poll(() => issues!.replica.get(NOTE), { timeout: 10_000 }).toBeUndefined();

    // The notes app still sees the group; nothing was denied.
    expect(await handshakeIds(notes!)).toContain(G_BRIDGE);
  });
});
