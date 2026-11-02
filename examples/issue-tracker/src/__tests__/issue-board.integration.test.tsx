// @vitest-environment happy-dom

/**
 * Integration coverage for the read surface (#440): the filtered issue
 * query behind the list and board, stable pagination across a grown
 * window, and a live edit from a second actor moving a card without a
 * reload.
 *
 * Every `it` short-circuits when the server isn't reachable, matching the
 * other integration suites: `pnpm test` stays green without a server and
 * `pnpm test:integration` exercises it when one is running.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createClient } from "@ebbjs/client";
import type { SeedData } from "@ebbjs/core/seed";
import { EbbProvider } from "@ebbjs/react";
import { demoActions } from "../actions";
import type { IssueTrackerClient } from "../bootstrap";
import { IssuesPanel } from "../IssuesPanel";
import { schema } from "../schema";
import { SEED_PERMISSIONS, SEEDER_ACTOR_ID, buildActorSeed, deriveActorSeedIds } from "../seed";
import { catchUpGroup, syncAllGroups } from "../sync-groups";
import { issueQuery } from "../use-issues";
import { ISSUE_PAGE_SIZE, NO_ISSUE_FILTERS, type IssueFilters } from "../issue-view";
import { SERVER_URL, serverIsReachable } from "./integration-support";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ALICE = `board_alice_${RUN_ID}`;
const BOB = `board_bob_${RUN_ID}`;
const SHARED_GROUP_ID = `grp_board_${RUN_ID}`;
const ALICE_IDS = deriveActorSeedIds(ALICE);

type Client = IssueTrackerClient;

const filters = (patch: Partial<IssueFilters> = {}): IssueFilters => ({
  ...NO_ISSUE_FILTERS,
  ...patch,
});

/** A shared group with both test actors, seeded by the service actor. */
async function seedSharedGroup(seeder: Client): Promise<void> {
  const bootstrap: SeedData = {
    groups: [{ id: SHARED_GROUP_ID, name: `Board ${RUN_ID}` }],
    groupMembers: [
      {
        id: `gms_board_seeder_${RUN_ID}`,
        actorId: SEEDER_ACTOR_ID,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [],
  };
  await seeder.seed(bootstrap);

  const members: SeedData = {
    groups: [],
    groupMembers: [
      {
        id: `gms_board_alice_${RUN_ID}`,
        actorId: ALICE,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
      {
        id: `gms_board_bob_${RUN_ID}`,
        actorId: BOB,
        groupId: SHARED_GROUP_ID,
        permissions: [...SEED_PERMISSIONS],
      },
    ],
    entities: [],
  };
  await seeder.seed(members);
}

let alice: Client | null = null;
let bob: Client | null = null;
let seeder: Client | null = null;
let unsubscribe: () => void = () => {};

beforeAll(async () => {
  if (!(await serverIsReachable())) {
    console.warn(`[skip] ebb server not reachable at ${SERVER_URL}`);
    return;
  }

  alice = createClient({ serverUrl: SERVER_URL, actorId: ALICE, schema, actions: demoActions });
  await alice.seed(buildActorSeed(ALICE));

  bob = createClient({ serverUrl: SERVER_URL, actorId: BOB, schema, actions: demoActions });
  await bob.seed(buildActorSeed(BOB));

  seeder = createClient({
    serverUrl: SERVER_URL,
    actorId: SEEDER_ACTOR_ID,
    schema,
    actions: demoActions,
  });
  await seedSharedGroup(seeder);

  for (const client of [alice, bob]) {
    await syncAllGroups(client);
  }
});

afterAll(() => {
  unsubscribe();
  alice?.close();
  bob?.close();
  seeder?.close();
});

afterEach(() => {
  cleanup();
});

describe("integration: issue list and board", () => {
  it("filters by status, priority, and the assignee relationship", async () => {
    if (!(await serverIsReachable())) return;

    const todo = await alice!.actions.createIssue({
      title: `aaa filter todo ${RUN_ID}`,
      status: "todo",
      priority: "low",
      assigneeId: null,
      groupId: SHARED_GROUP_ID,
    });
    const doing = await alice!.actions.createIssue({
      title: `aaa filter doing ${RUN_ID}`,
      status: "in_progress",
      priority: "high",
      assigneeId: null,
      groupId: SHARED_GROUP_ID,
    });
    await alice!.actions.setIssueAssignee({ id: doing.id, assigneeId: ALICE_IDS.profileId });
    await catchUpGroup(alice!, SHARED_GROUP_ID);

    const statusRows = await issueQuery(filters({ status: "todo" }), 100)(alice!);
    expect(statusRows.map((row) => row.id)).toContain(todo.id);
    expect(statusRows.map((row) => row.id)).not.toContain(doing.id);

    const priorityRows = await issueQuery(filters({ priority: "high" }), 100)(alice!);
    expect(priorityRows.map((row) => row.id)).toContain(doing.id);
    expect(priorityRows.map((row) => row.id)).not.toContain(todo.id);

    const assigneeRows = await issueQuery(filters({ assignee: ALICE_IDS.profileId }), 100)(alice!);
    expect(assigneeRows.map((row) => row.id)).toContain(doing.id);
    expect(assigneeRows.map((row) => row.id)).not.toContain(todo.id);
    expect(assigneeRows.find((row) => row.id === doing.id)?.assignee?.id).toBe(ALICE_IDS.profileId);

    const combined = await issueQuery(filters({ status: "todo", priority: "low" }), 100)(alice!);
    expect(combined.map((row) => row.id)).toContain(todo.id);
    expect(combined.map((row) => row.id)).not.toContain(doing.id);
  });

  it("grows the window without duplicating or dropping rows, even after a live reorder", async () => {
    if (!(await serverIsReachable())) return;

    const created: string[] = [];
    for (let index = 0; index < ISSUE_PAGE_SIZE + 5; index++) {
      const row = await alice!.actions.createIssue({
        title: `page ${String(index).padStart(3, "0")} ${RUN_ID}`,
        status: "todo",
        priority: "urgent",
        assigneeId: null,
        groupId: SHARED_GROUP_ID,
      });
      created.push(row.id);
    }
    await catchUpGroup(alice!, SHARED_GROUP_ID);

    // A unique filter keeps the fixture isolated from the other cases.
    const scoped = filters({ status: "todo", priority: "urgent" });
    const firstPage = await issueQuery(scoped, ISSUE_PAGE_SIZE)(alice!);
    const nextPage = await issueQuery(scoped, ISSUE_PAGE_SIZE * 2)(alice!);

    expect(firstPage).toHaveLength(ISSUE_PAGE_SIZE);
    expect(nextPage).toHaveLength(created.length);
    expect(nextPage.slice(0, firstPage.length).map((row) => row.id)).toEqual(
      firstPage.map((row) => row.id),
    );
    expect(new Set(nextPage.map((row) => row.id)).size).toBe(nextPage.length);
    expect(new Set(nextPage.map((row) => row.id))).toEqual(new Set(created));

    // A live edit to the ordering field reorders the collection; the
    // grown window is still a stable prefix of the same query.
    const moved = created[created.length - 1]!;
    await bob!.actions.updateIssue({
      id: moved,
      patch: { title: `page 0000 moved ${RUN_ID}` },
    });
    await catchUpGroup(alice!, SHARED_GROUP_ID);

    const firstAfter = await issueQuery(scoped, ISSUE_PAGE_SIZE)(alice!);
    const nextAfter = await issueQuery(scoped, ISSUE_PAGE_SIZE * 2)(alice!);
    expect(nextAfter.slice(0, firstAfter.length).map((row) => row.id)).toEqual(
      firstAfter.map((row) => row.id),
    );
    expect(new Set(nextAfter.map((row) => row.id)).size).toBe(nextAfter.length);
    expect(new Set(nextAfter.map((row) => row.id))).toEqual(new Set(created));
  });

  it("renders the list and the board from one query and follows a remote edit live", async () => {
    if (!(await serverIsReachable())) return;

    const issue = await alice!.actions.createIssue({
      title: `000 live issue ${RUN_ID}`,
      status: "todo",
      priority: "medium",
      assigneeId: null,
      groupId: SHARED_GROUP_ID,
    });
    await catchUpGroup(alice!, SHARED_GROUP_ID);

    // Open the same live stream the app's bootstrap opens, and wait for the
    // subscription's initial catch-up before the edit that must arrive on it
    // (the Outbox holds writes until that checkpoint).
    unsubscribe = alice!.subscribe([SHARED_GROUP_ID], () => undefined);
    await waitFor(() => expect(alice!.state).toBe("live"), { timeout: 10_000 });

    render(
      <EbbProvider client={alice!}>
        <IssuesPanel selectedId={null} onSelect={vi.fn()} onNewIssue={vi.fn()} />
      </EbbProvider>,
    );

    expect(await screen.findByText(`000 live issue ${RUN_ID}`)).toBeTruthy();

    // The toolbar writes predicates into the same chain the list renders.
    fireEvent.change(screen.getByLabelText("status"), { target: { value: "todo" } });
    await waitFor(() => expect(screen.queryByText(`aaa filter doing ${RUN_ID}`)).toBeNull());
    expect(screen.getByText(`000 live issue ${RUN_ID}`)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("status"), { target: { value: "" } });
    expect(await screen.findByText(`aaa filter doing ${RUN_ID}`)).toBeTruthy();

    screen.getByRole("button", { name: "board" }).click();
    expect(await screen.findByTestId("issue-board")).toBeTruthy();
    expect(screen.getByTestId(`board-card-${issue.id}`)).toBeTruthy();
    expect(screen.getByTestId("board-column-todo").textContent).toContain(
      `000 live issue ${RUN_ID}`,
    );

    const renamed = `000 live issue renamed ${RUN_ID}`;
    await bob!.actions.updateIssue({
      id: issue.id,
      patch: { title: renamed, status: "done" },
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("board-column-done").textContent).toContain(renamed);
        expect(screen.getByTestId("board-column-todo").textContent).not.toContain(renamed);
      },
      { timeout: 10_000 },
    );

    screen.getByRole("button", { name: "list" }).click();
    expect(await screen.findByText(renamed)).toBeTruthy();
  });
});
