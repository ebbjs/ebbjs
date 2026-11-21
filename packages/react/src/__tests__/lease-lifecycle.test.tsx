/**
 * The React read hooks own the subscription lifecycle (#944).
 *
 * A mounted hook acquires the components its read needs and holds them for as
 * long as it is mounted; unmounting releases every one and starts the one
 * residency TTL, which keeps the result and its claims warm so a remount
 * inside it reads nothing and re-runs nothing unless the read set went stale.
 * `useSyncExternalStore` is the only ownership path — it subscribes once per
 * committed mount and calls the one unsubscribe it was handed — so React's
 * double-invoked effects, an abandoned concurrent render, and a render that
 * throws all end on that same release.
 *
 * The numbers below come from the replica's own lease table and the registry's
 * own entry table, which makes "released" a count rather than a callback that
 * happened to be called.
 */

import { StrictMode, Suspense, startTransition, useState } from "react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  defineModel,
  defineSchema,
  e,
  type NamespacedClient,
  type QueryStatus,
} from "@ebbjs/client";
import { componentName, type FieldValue, type Update } from "@ebbjs/core";
import { useQuery, type QueryRoot } from "../index";
import { makeClient, renderWithClient, withProvider } from "./support";

const note = defineModel("note", { title: e.string(), body: e.string(), tag: e.string() });
const todo = defineModel("todo", { title: e.string() });

const schema = defineSchema({ models: { note, todo }, version: 1 });

type Schema = typeof schema;
type Client = NamespacedClient<Schema>;

let seedPosition = 0;

const leaf = (value: string): FieldValue => ({
  value,
  update_id: `u_${seedPosition}`,
  hlc: "1",
});

/** The stored form of a row: what the entity store serves a cold read. */
type StoredRow = {
  readonly id: string;
  readonly model: string;
  readonly data: { readonly fields: Record<string, FieldValue> };
  readonly exists: boolean;
  readonly created_hlc: string;
  readonly updated_hlc: string;
  readonly deleted_hlc: string | null;
  readonly last_gsn: number;
};

const storedRow = (id: string, model: string, fields: Record<string, string>): StoredRow => {
  const stored: Record<string, FieldValue> = {};
  for (const [field, value] of Object.entries(fields)) stored[field] = leaf(value);
  return {
    id,
    model,
    data: { fields: stored },
    exists: true,
    created_hlc: "1",
    updated_hlc: "1",
    deleted_hlc: null,
    last_gsn: seedPosition,
  };
};

/** Fold one Action's Updates into the client's replica. */
const fold = (client: Client, updates: readonly Update[]): void => {
  seedPosition += 1;
  client.replica.ingest(
    { id: `a_seed_${seedPosition}`, actor_id: "seed", hlc: "1", gsn: seedPosition, updates: [] },
    updates,
    seedPosition,
  );
};

/**
 * A row the replica files under its model but holds little of: its `tag` is
 * folded so a predicate can match it, and the projected values are the entity
 * store's to serve. That is what a read installs, and what a lease then keeps.
 */
const storeBacked = async (
  client: Client,
  id: string,
  fields: Record<string, string>,
): Promise<void> => {
  seedPosition += 1;
  fold(client, [
    {
      id: `u_seed_${seedPosition}`,
      subject_id: id,
      component: "note/tag",
      method: "replace",
      data: leaf(fields.tag ?? ""),
    },
  ]);
  await client.storage.entities.set(storedRow(id, "note", fields));
};

/** A fully folded row: the replica's own data, so no lease decides it. */
const seed = async (
  client: Client,
  id: string,
  fields: Record<string, string>,
  model = "note",
): Promise<void> => {
  seedPosition += 1;
  const row = storedRow(id, model, fields);
  fold(
    client,
    Object.entries(row.data.fields).map(([field, data]) => ({
      id: `u_seed_${seedPosition}_${field}`,
      subject_id: id,
      component: componentName(model, field),
      method: "replace" as const,
      data,
    })),
  );
  await client.storage.entities.set(row);
};

const flush = () => act(async () => {});

const leases = (client: Client) => client.replicaStats.leases;

/** Wait until the mounted result holds `count` claims. */
const settled = async (client: Client, count: number): Promise<void> =>
  waitFor(() => expect(leases(client).leased).toBe(count));

/** Projected rows plus the status and loading flag the hook reports. */
function NoteList({ tag }: { tag?: string } = {}) {
  const { data, status, loading, error } = useQuery(
    (q: QueryRoot<Schema>) =>
      tag === undefined ? q.note.query() : q.note.query().where("tag", tag),
    [tag],
  );
  const rows = data ?? [];
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error === null ? "" : error.message}</span>
      <span data-testid="unloaded">{String(data === undefined)}</span>
      <span data-testid="titles">{rows.map((row) => String(row.title)).join(",")}</span>
    </div>
  );
}

/** An error boundary: a render that throws unwinds to it, and React unmounts. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <span data-testid="fallback">failed</span> : this.props.children;
  }
}

/** The same hook, but a later render throws once a result exists. */
function Exploding({ explode }: { explode: boolean }) {
  const { data } = useQuery((q: QueryRoot<Schema>) => q.note.query());
  if (explode && data !== undefined) throw new Error("boom during render");
  return <NoteList />;
}

afterEach(cleanup);

describe("useQuery lease lifecycle (#944)", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient({ schema, residencyTtlMs: 250 });
  });

  it("leases the components a mounted result read and releases every one on unmount", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "body", tag: "a" });
    expect(leases(client)).toMatchObject({ leased: 0, inactive: 0, resident: 0 });

    const { unmount } = renderWithClient(client, <NoteList />);
    // Every component the row carries, because an unselected row read reads the
    // model whole: two the store served, one the log had already folded.
    await settled(client, 3);

    expect(leases(client)).toMatchObject({
      leased: 3,
      inactive: 0,
      byComponent: {
        "note/title": { leased: 1, inactive: 0 },
        "note/body": { leased: 1, inactive: 0 },
        "note/tag": { leased: 1, inactive: 0 },
      },
    });
    expect(client.subscriptions.stats()).toMatchObject({ live: 1, inactive: 0, dependencies: 3 });

    unmount();

    // Unmount releases the subscriber, not the values: the result goes
    // inactive and keeps its claims while the one residency TTL runs.
    expect(client.subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });
    expect(leases(client)).toMatchObject({ leased: 3, inactive: 0 });

    // The TTL ends the result and its claims together; each value then waits
    // out its own grace period before it leaves.
    await waitFor(() => expect(client.subscriptions.stats().inactive).toBe(0));
    expect(leases(client)).toMatchObject({ leased: 0, inactive: 3 });
    await waitFor(() => expect(leases(client).resident).toBe(0));
    expect(leases(client)).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
  });

  it("remounts inside the TTL with no store read and no re-run when nothing it read changed", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "body", tag: "a" });

    const first = renderWithClient(client, <NoteList />);
    await settled(client, 3);
    expect(screen.getByTestId("status").textContent).toBe("current");

    // The entry this mount created: the remount has to take *this* one back.
    // The read spies below cannot tell the difference — a fresh entry would
    // leave the old one's claims holding the values resident, so neither a
    // store read nor an `iterate` would happen either way. The identity is what
    // covers the reuse path.
    const entries = client.subscriptions.entries();
    expect(entries).toHaveLength(1);
    const entryId = client.subscriptions.peek("query", entries[0].key)?.id;
    expect(entryId).toBeDefined();

    const storeReads = vi.spyOn(client.storage.entities, "get");
    const runs = vi.spyOn(client.replica, "iterate");

    first.unmount();
    expect(client.subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });
    // A write to another model: the dependency index never hands the inactive
    // result the batch, so its cursor stays level with the replica.
    await act(async () => {
      await seed(client, "todo_1", { title: "Other" }, "todo");
    });
    expect(runs).not.toHaveBeenCalled();

    renderWithClient(client, <NoteList />);
    await flush();

    expect(screen.getByTestId("status").textContent).toBe("current");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("titles").textContent).toBe("One");
    // The warm result is the result: no store read, and no run to produce it.
    expect(storeReads).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
    // Same entry, so the claims were taken back rather than orphaned behind a
    // second one that would hydrate from the replica on its own.
    expect(client.subscriptions.entries()).toHaveLength(1);
    expect(client.subscriptions.peek("query", entries[0].key)?.id).toBe(entryId);
  });

  it("re-runs once on a remount whose held result went stale", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "body", tag: "a" });

    const first = renderWithClient(client, <NoteList />);
    await settled(client, 3);
    expect(screen.getByTestId("status").textContent).toBe("current");

    const storeReads = vi.spyOn(client.storage.entities, "get");
    const runs = vi.spyOn(client.replica, "iterate");

    first.unmount();
    // A change to a component the result projects: the inactive result keeps
    // the revision its rows reflect, so the remount sees `stale` once.
    await act(async () => {
      await seed(client, "note_1", { title: "Renamed", body: "body", tag: "a" });
    });
    expect(runs).not.toHaveBeenCalled();

    const seen: QueryStatus[] = [];
    function Traced() {
      const { data, status } = useQuery((q: QueryRoot<Schema>) => q.note.query());
      seen.push(status);
      return <span data-testid="rows">{data?.map((row) => String(row.title)).join(",")}</span>;
    }

    renderWithClient(client, <Traced />);
    await flush();

    expect(runs).toHaveBeenCalledTimes(1);
    // The claims the inactive result owns survived, so the re-run read the
    // replica and not the store.
    expect(storeReads).not.toHaveBeenCalled();
    expect(seen[0]).toBe("stale");
    expect(seen.at(-1)).toBe("current");
    expect(screen.getByTestId("rows").textContent).toBe("Renamed");
  });

  it("releases every lease when a render throws and the boundary unmounts the tree", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "body", tag: "a" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = renderWithClient(
      client,
      <Boundary>
        <Exploding explode={false} />
      </Boundary>,
    );
    await settled(client, 3);

    // The throw unwinds the mounted component into the boundary, so React runs
    // the same cleanup an unmount runs.
    rerender(
      withProvider(
        client,
        <Boundary>
          <Exploding explode />
        </Boundary>,
      ),
    );

    expect(screen.getByTestId("fallback").textContent).toBe("failed");
    expect(client.subscriptions.stats()).toMatchObject({ live: 0, inactive: 1 });
    expect(leases(client)).toMatchObject({ leased: 3, inactive: 0 });

    await waitFor(() => expect(leases(client).resident).toBe(0));
    expect(leases(client)).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
    consoleError.mockRestore();
  });

  it("takes no lease for a render that never commits", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "body", tag: "a" });
    // A promise that never settles: React renders the fallback and throws the
    // unfinished tree away, so no effect ever subscribes.
    const pending = new Promise<never>(() => {});

    function Suspending(): never {
      throw pending;
    }

    renderWithClient(
      client,
      <Suspense fallback={<span data-testid="fallback">waiting</span>}>
        <Suspending />
        <NoteList />
      </Suspense>,
    );
    await flush();

    expect(screen.getByTestId("fallback").textContent).toBe("waiting");
    expect(leases(client).resident).toBe(0);
    expect(client.subscriptions.stats()).toMatchObject({ live: 0, inactive: 0 });
  });

  it("takes the same acquisitions and releases in StrictMode as in a plain mount", async () => {
    /** Mount `NoteList` (`strict` or not), unmount, and count the lease traffic. */
    const run = async (strict: boolean) => {
      const fresh = makeClient({ schema, residencyTtlMs: 250 });
      await storeBacked(fresh, "note_1", { title: "One", body: "body", tag: "a" });
      const acquired: number[] = [];
      let releases = 0;
      const realAcquire = fresh.replica.acquire.bind(fresh.replica);
      vi.spyOn(fresh.replica, "acquire").mockImplementation(async (id, components) => {
        acquired.push(components.length);
        const release = await realAcquire(id, components);
        return () => {
          releases += 1;
          release();
        };
      });

      const list = <NoteList />;
      const tree = withProvider(fresh, list);
      const { unmount } = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
      await waitFor(() => expect(leases(fresh).leased).toBe(3));
      const mounted = {
        refs: fresh.subscriptions.entries().map((entry) => entry.refs),
        leased: leases(fresh).leased,
        acquired: [...acquired],
        titles: screen.getByTestId("titles").textContent,
      };

      unmount();
      await waitFor(() => expect(leases(fresh).resident).toBe(0));
      return { mounted, acquired, releases };
    };

    const plain = await run(false);
    cleanup();
    const strict = await run(true);

    // Subscribe, unsubscribe, subscribe: the second mount takes the inactive
    // entry back instead of re-acquiring what the first one still holds, so the
    // traffic is the plain mount's traffic — one page acquisition for the cold
    // read, one claim set for the subscription, released once at the TTL.
    expect(strict.mounted).toEqual(plain.mounted);
    expect(strict.acquired).toEqual(plain.acquired);
    expect(strict.releases).toBe(plain.releases);
    expect(plain.mounted).toMatchObject({ refs: [1], leased: 3, acquired: [3, 3], titles: "One" });
    expect(plain.acquired).toEqual([3, 3]);
    expect(plain.releases).toBe(2);
  });

  it("keeps one entry through a transition that swaps the query", async () => {
    await storeBacked(client, "note_1", { title: "One", body: "a", tag: "a" });
    await storeBacked(client, "note_2", { title: "Two", body: "b", tag: "b" });

    let swap: (tag: string) => void = () => {};
    function Swapper() {
      const [tag, setTag] = useState("a");
      swap = setTag;
      return <NoteList tag={tag} />;
    }

    const { unmount } = renderWithClient(client, <Swapper />);
    await settled(client, 3);
    expect(screen.getByTestId("titles").textContent).toBe("One");
    expect(client.subscriptions.entries().map((entry) => entry.refs)).toEqual([1]);

    await act(async () => {
      startTransition(() => swap("b"));
    });
    await waitFor(() => expect(screen.getByTestId("titles").textContent).toBe("Two"));

    // The old entry went inactive and the new one is live: no entry ever held
    // two subscribers, so no component was claimed twice.
    const entries = client.subscriptions.entries();
    expect(entries.map((entry) => entry.state)).toEqual(["inactive", "live"]);
    expect(entries.map((entry) => entry.refs)).toEqual([0, 1]);

    unmount();
    expect(client.subscriptions.stats().live).toBe(0);
    await waitFor(() => expect(client.subscriptions.stats().inactive).toBe(0));
    await waitFor(() => expect(leases(client).resident).toBe(0));
    expect(leases(client)).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
  });
});
