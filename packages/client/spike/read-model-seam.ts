/**
 * THROWAWAY ARCHITECTURE PROTOTYPE RUNNER — ebbjs#496.
 *
 * Logic/architecture prototype, not a UI one. One command:
 *
 *   pnpm storage:build          # tsx resolves @ebbjs/storage/memory from dist
 *   pnpm --filter @ebbjs/client spike:read-model-seam
 *
 * It dual-runs the resident read model (`read-model.ts`) beside the existing
 * `createMemoryAdapter()`, asserting entity- and type-equivalence after every
 * operation, and confirms the #495 footprint/full-tree figures in-process.
 *
 * This file is disposable. Main keeps only the decision recorded on #496.
 */

import { isDeepStrictEqual } from "node:util";
import type { Action, Entity, FieldValue, Update } from "@ebbjs/core";
import { makeHlc } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";
import { applyLocalUpdate } from "../src/sync/client.ts";
import { applyUpdate } from "../../storage/src/internal/materialize";
import { mergeActionUpdates } from "../../storage/src/internal/action-merge";
import {
  applyOptimistic,
  createReadModel,
  hydrate,
  ingestDurable,
  type DurableStore,
  type ReadModel,
  type ReadModelSnapshot,
} from "./read-model.ts";

// ---------------------------------------------------------------------------
// Small reporting harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    passed += 1;
    console.log(`  [ok] ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : `\n         ${detail}`}`);
  }
};

const section = (title: string): void => {
  console.log(`\n== ${title} ==`);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_711_036_800_000;
const hlc = (ms: number, counter = 0): string => makeHlc(T0 + ms, counter);

let updateSeq = 0;
const nextUpdateId = (prefix = "u"): string => `${prefix}_${updateSeq++}`;

const leaf = (value: unknown, hlcString: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: hlcString,
});

interface ActionSpec {
  readonly id: string;
  readonly gsn: number;
  readonly hlc: string;
  readonly updates: readonly Update[];
}

const mkAction = (spec: ActionSpec): Action => ({
  id: spec.id,
  actor_id: "a_test",
  hlc: spec.hlc,
  gsn: spec.gsn,
  updates: [...spec.updates],
});

const putUpdate = (
  subjectId: string,
  subjectType: string,
  fields: Record<string, FieldValue>,
  updateId = nextUpdateId(),
): Update => ({
  id: updateId,
  subject_id: subjectId,
  subject_type: subjectType,
  method: "put",
  data: { fields },
});

const patchUpdate = (
  subjectId: string,
  fields: Record<string, FieldValue>,
  updateId = nextUpdateId(),
): Update => ({
  id: updateId,
  subject_id: subjectId,
  subject_type: "todo",
  method: "patch",
  data: { fields },
});

const deleteUpdate = (subjectId: string, updateId = nextUpdateId()): Update => ({
  id: updateId,
  subject_id: subjectId,
  subject_type: "todo",
  method: "delete",
  data: null,
});

const affected = (action: Action): string[] => [
  ...new Set(action.updates.map((update) => update.subject_id)),
];

const byId = (rows: readonly Entity[]): Entity[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ---------------------------------------------------------------------------
// A faithful-enough in-memory DurableStore (ports only).
// ---------------------------------------------------------------------------

interface StoredLogEntry {
  action: Action;
  readonly position: number;
  added: readonly Update[];
}

class MemoryPorts implements DurableStore {
  private log: StoredLogEntry[] = [];
  private readonly byActionId = new Map<string, StoredLogEntry>();
  private snapshot: ReadModelSnapshot | null = null;
  private position = 0;
  private readonly cursorValues = new Map<string, number>();
  readonly outboxEntries: { action: Action; status: string }[] = [];

  // Mirror the real ActionLog: a repeated Action id merges its Updates (#473),
  // and append reports only the newly-added Updates so the incremental model
  // folds each once.
  private readonly append = async (action: Action): Promise<StoredLogEntry> => {
    const existing = this.byActionId.get(action.id);
    if (existing === undefined) {
      const entry: StoredLogEntry = { action, position: ++this.position, added: action.updates };
      this.log.push(entry);
      this.byActionId.set(action.id, entry);
      return entry;
    }
    const known = new Set(existing.action.updates.map((update) => update.id));
    const added = action.updates.filter((update) => !known.has(update.id));
    existing.action = {
      ...existing.action,
      updates: mergeActionUpdates(existing.action.updates, action.updates),
    };
    existing.added = added;
    return existing;
  };

  readonly actions = {
    append: this.append,
    readTail: async (afterPosition: number): Promise<readonly StoredLogEntry[]> =>
      this.log
        .filter((entry) => entry.position > afterPosition)
        .map((entry) => ({
          action: entry.action,
          position: entry.position,
          added: entry.action.updates,
        })),
    lastPosition: async (): Promise<number> => this.position,
    clear: async (): Promise<void> => {
      this.log = [];
      this.byActionId.clear();
      this.position = 0;
    },
  };

  readonly snapshots = {
    load: async (): Promise<ReadModelSnapshot | null> => this.snapshot,
    save: async (snapshot: ReadModelSnapshot): Promise<void> => {
      this.snapshot = snapshot;
    },
    clear: async (): Promise<void> => {
      this.snapshot = null;
    },
  };

  readonly cursors = {
    get: async (groupId: string): Promise<number | null> => this.cursorValues.get(groupId) ?? null,
    set: async (groupId: string, gsn: number): Promise<void> => {
      this.cursorValues.set(groupId, gsn);
    },
  };

  readonly outbox = {
    list: async (): Promise<readonly { action: Action; status: string }[]> => this.outboxEntries,
  };
}

// ---------------------------------------------------------------------------
// The dual-run harness: one operation, applied to both sides.
// ---------------------------------------------------------------------------

class DualRun {
  readonly model: ReadModel = createReadModel();
  readonly ports = new MemoryPorts();
  readonly adapter: StorageAdapter = createMemoryAdapter();

  async durable(action: Action, groupId?: string): Promise<void> {
    await ingestDurable(this.model, this.ports, action, groupId);
    await this.adapter.actions.append(action);
    for (const id of affected(action)) await this.adapter.entities.get(id);
  }

  async optimistic(action: Action): Promise<void> {
    applyOptimistic(this.model, action);
    for (const update of action.updates) {
      const current = await this.adapter.entities.get(update.subject_id);
      const next = applyLocalUpdate(current, update, action.hlc);
      if (next !== null) await this.adapter.entities.set(next);
    }
  }

  /** Assert the read model's view equals the adapter's after one operation. */
  async assertEquivalent(
    label: string,
    ids: readonly string[],
    types: readonly string[],
  ): Promise<void> {
    for (const id of ids) {
      const mine = this.model.get(id);
      const theirs = await this.adapter.entities.get(id);
      check(
        `${label}: get(${id})`,
        isDeepStrictEqual(mine, theirs),
        `read-model=${JSON.stringify(mine)}\n         adapter  =${JSON.stringify(theirs)}`,
      );
    }
    for (const type of types) {
      const mine = byId(this.model.iterate(type));
      const theirs = byId(await this.adapter.entities.query(type));
      check(
        `${label}: iterate(${type})`,
        isDeepStrictEqual(mine, theirs),
        `read-model=${JSON.stringify(mine.map((e) => e.id))}\n         adapter  =${JSON.stringify(theirs.map((e) => e.id))}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Required equivalence cases
// ---------------------------------------------------------------------------

const runRequiredCases = async (): Promise<void> => {
  section("Required dual-run cases");
  updateSeq = 0;

  // put
  {
    const dual = new DualRun();
    const action = mkAction({
      id: "a_put",
      gsn: 1,
      hlc: hlc(1),
      updates: [putUpdate("todo_1", "todo", { title: leaf("Hello", hlc(1), "u_title_1") })],
    });
    await dual.durable(action);
    await dual.assertEquivalent("put", ["todo_1"], ["todo"]);
  }

  // patch (higher HLC wins)
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_put",
        gsn: 1,
        hlc: hlc(1),
        updates: [putUpdate("todo_1", "todo", { title: leaf("Hello", hlc(1), "u_t1") })],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_patch",
        gsn: 2,
        hlc: hlc(2),
        updates: [patchUpdate("todo_1", { title: leaf("Updated", hlc(2), "u_t2") })],
      }),
    );
    await dual.assertEquivalent("patch (higher HLC)", ["todo_1"], ["todo"]);
  }

  // patch with a lower HLC is ignored, and the version handle does not move
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_put",
        gsn: 1,
        hlc: hlc(5),
        updates: [putUpdate("todo_1", "todo", { title: leaf("Hello", hlc(5), "u_t1") })],
      }),
    );
    const before = dual.model.handle();
    const beforeVersion = before.version;
    await dual.durable(
      mkAction({
        id: "a_stale",
        gsn: 2,
        hlc: hlc(3),
        updates: [patchUpdate("todo_1", { title: leaf("Stale", hlc(3), "u_t2") })],
      }),
    );
    check("patch (lower HLC): version handle unchanged", dual.model.handle() === before);
    check("patch (lower HLC): version unchanged", dual.model.version === beforeVersion);
    await dual.assertEquivalent("patch (lower HLC ignored)", ["todo_1"], ["todo"]);
  }

  // patch with an equal HLC: tiebreak toward the lexicographically greater update_id
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_put",
        gsn: 1,
        hlc: hlc(5),
        updates: [putUpdate("todo_1", "todo", { title: leaf("Base", hlc(5), "u_mmm") })],
      }),
    );
    // winner: update_id "u_zzz" > "u_mmm"
    await dual.durable(
      mkAction({
        id: "a_tie_win",
        gsn: 2,
        hlc: hlc(5),
        updates: [patchUpdate("todo_1", { title: leaf("Winner", hlc(5), "u_zzz") })],
      }),
    );
    check(
      "equal-HLC tiebreak: greater update_id wins",
      dual.model.get("todo_1")?.data.fields.title?.value === "Winner",
    );
    // loser: update_id "u_aaa" < "u_zzz"
    await dual.durable(
      mkAction({
        id: "a_tie_lose",
        gsn: 3,
        hlc: hlc(5),
        updates: [patchUpdate("todo_1", { title: leaf("Loser", hlc(5), "u_aaa") })],
      }),
    );
    check(
      "equal-HLC tiebreak: smaller update_id loses",
      dual.model.get("todo_1")?.data.fields.title?.value === "Winner",
    );
    await dual.assertEquivalent("equal-HLC tiebreak", ["todo_1"], ["todo"]);
  }

  // map-union fields: a patch to one key keeps its siblings
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_put",
        gsn: 1,
        hlc: hlc(1),
        updates: [
          putUpdate("doc_1", "doc", {
            content: { map: { a: leaf("A", hlc(1), "u_a") } },
          }),
        ],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_map",
        gsn: 2,
        hlc: hlc(2),
        updates: [
          {
            id: "u_b",
            subject_id: "doc_1",
            subject_type: "doc",
            method: "patch",
            data: { fields: { content: { map: { b: leaf("B", hlc(2), "u_b") } } } },
          },
        ],
      }),
    );
    const content = dual.model.get("doc_1")?.data.fields.content;
    const keys = content !== undefined && "map" in content ? Object.keys(content.map).sort() : [];
    check("map-union: both keys survive", isDeepStrictEqual(keys, ["a", "b"]));
    await dual.assertEquivalent("map-union fields", ["doc_1"], ["doc"]);
  }

  // delete → tombstone, and a read of the deleted entity
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_put",
        gsn: 1,
        hlc: hlc(1),
        updates: [putUpdate("todo_1", "todo", { title: leaf("Hello", hlc(1), "u_t1") })],
      }),
    );
    await dual.durable(
      mkAction({ id: "a_del", gsn: 2, hlc: hlc(2), updates: [deleteUpdate("todo_1")] }),
    );
    const row = dual.model.get("todo_1");
    check("delete: tombstone retained by get()", row !== null && row.deleted_hlc !== null);
    check(
      "delete: tombstone hidden from live projection (deleted_hlc set)",
      row?.deleted_hlc === hlc(2),
    );
    await dual.assertEquivalent("delete → tombstone", ["todo_1"], ["todo"]);

    // patch on a deleted entity is ignored
    await dual.durable(
      mkAction({
        id: "a_patch_deleted",
        gsn: 3,
        hlc: hlc(3),
        updates: [patchUpdate("todo_1", { title: leaf("Nope", hlc(3), "u_t2") })],
      }),
    );
    check(
      "patch on deleted: ignored",
      dual.model.get("todo_1")?.data.fields.title?.value === "Hello",
    );
    await dual.assertEquivalent("read of a deleted entity", ["todo_1"], ["todo"]);
  }

  // optimistic put then server echo
  {
    const dual = new DualRun();
    const local = mkAction({
      id: "a_local_put",
      gsn: 0,
      hlc: hlc(1),
      updates: [putUpdate("todo_opt", "todo", { title: leaf("Optimistic", hlc(1), "u_opt") })],
    });
    await dual.optimistic(local);
    check(
      "optimistic put: visible before echo",
      dual.model.get("todo_opt")?.data.fields.title?.value === "Optimistic",
    );
    await dual.assertEquivalent("optimistic put (pre-echo)", ["todo_opt"], ["todo"]);

    const echo = mkAction({ ...local, gsn: 10 });
    await dual.durable(echo);
    check(
      "optimistic put: echo converges",
      dual.model.get("todo_opt")?.data.fields.title?.value === "Optimistic",
    );
    await dual.assertEquivalent("optimistic put then echo", ["todo_opt"], ["todo"]);
  }

  // optimistic patch whose base is missing
  {
    const dual = new DualRun();
    const local = mkAction({
      id: "a_local_patch",
      gsn: 0,
      hlc: hlc(1),
      updates: [patchUpdate("todo_missing", { title: leaf("Orphan", hlc(1), "u_orphan") })],
    });
    await dual.optimistic(local);
    check("optimistic patch w/o base: stays absent", dual.model.get("todo_missing") === null);
    await dual.assertEquivalent("optimistic patch (missing base)", ["todo_missing"], ["todo"]);
  }

  // #475 backfill: a synthetic gsn-0 snapshot put
  {
    const dual = new DualRun();
    const backfill = mkAction({
      id: "a_backfill",
      gsn: 0,
      hlc: hlc(1),
      updates: [putUpdate("todo_bf", "todo", { title: leaf("Backfilled", hlc(1), "u_bf") })],
    });
    await dual.durable(backfill);
    check(
      "backfill gsn-0 put: materialized",
      dual.model.get("todo_bf")?.data.fields.title?.value === "Backfilled",
    );
    await dual.assertEquivalent("#475 backfill (gsn-0 put)", ["todo_bf"], ["todo"]);
  }

  // type-index membership across a type change
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_type_a",
        gsn: 1,
        hlc: hlc(1),
        updates: [putUpdate("thing_1", "alpha", { name: leaf("A", hlc(1), "u_n1") })],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_type_b",
        gsn: 2,
        hlc: hlc(2),
        updates: [putUpdate("thing_1", "beta", { name: leaf("B", hlc(2), "u_n2") })],
      }),
    );
    check("type change: old type empty", dual.model.iterate("alpha").length === 0);
    check("type change: new type has row", dual.model.iterate("beta").length === 1);
    await dual.assertEquivalent(
      "type-index membership across a type change",
      ["thing_1"],
      ["alpha", "beta"],
    );
  }

  // CursorStore: durable ingest advances the per-group cursor to the max gsn.
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_c1",
        gsn: 4,
        hlc: hlc(1),
        updates: [putUpdate("todo_c", "todo", { title: leaf("C", hlc(1), "u_c") })],
      }),
      "grp_1",
    );
    await dual.durable(
      mkAction({
        id: "a_c2",
        gsn: 7,
        hlc: hlc(2),
        updates: [patchUpdate("todo_c", { title: leaf("C2", hlc(2), "u_c2") })],
      }),
      "grp_1",
    );
    check("cursor advanced to the max gsn", (await dual.ports.cursors.get("grp_1")) === 7);
  }

  // #475: a patch can be delivered before the base it targets; the backfilled
  // base arrives later and the in-flight patch must still apply on top.
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_bf_patch",
        gsn: 2,
        hlc: hlc(9),
        updates: [patchUpdate("todo_bf2", { title: leaf("InFlight", hlc(9), "u_inflight") })],
      }),
    );
    check("patch before base: absent until backfilled", dual.model.get("todo_bf2") === null);
    await dual.durable(
      mkAction({
        id: "a_bf_base",
        gsn: 0,
        hlc: hlc(5),
        updates: [putUpdate("todo_bf2", "todo", { title: leaf("Server", hlc(5), "u_server") })],
      }),
    );
    check(
      "patch before base: in-flight patch wins",
      dual.model.get("todo_bf2")?.data.fields.title?.value === "InFlight",
    );
    await dual.assertEquivalent(
      "patch delivered before backfilled base (#475)",
      ["todo_bf2"],
      ["todo"],
    );
  }

  // The backfill snapshot may instead carry the entity's TRUE gsn + updated_hlc
  // rather than 0. gsn ordering places it at its causal position; the earlier
  // patch (gsn 2 > snapshot gsn 1) still merges on top. This is the proposed
  // fix, and it preserves the row's last_gsn.
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_tg_patch",
        gsn: 2,
        hlc: hlc(9),
        updates: [patchUpdate("todo_tg", { title: leaf("InFlight", hlc(9), "u_inflight") })],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_tg_base",
        gsn: 1,
        hlc: hlc(5),
        updates: [putUpdate("todo_tg", "todo", { title: leaf("Server", hlc(5), "u_server") })],
      }),
    );
    check(
      "true-gsn backfill: in-flight patch wins",
      dual.model.get("todo_tg")?.data.fields.title?.value === "InFlight",
    );
    check(
      "true-gsn backfill: row keeps the true last_gsn",
      dual.model.get("todo_tg")?.last_gsn === 2,
    );
    await dual.assertEquivalent("backfill with the entity's true gsn", ["todo_tg"], ["todo"]);
  }

  // #473: one Action id delivered once per group, each copy carrying disjoint
  // Updates. The read model must fold the union exactly once.
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_pg",
        gsn: 5,
        hlc: hlc(1),
        updates: [putUpdate("todo_pg1", "todo", { title: leaf("One", hlc(1), "u_pg1") })],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_pg",
        gsn: 5,
        hlc: hlc(1),
        updates: [putUpdate("todo_pg2", "todo", { title: leaf("Two", hlc(1), "u_pg2") })],
      }),
    );
    await dual.assertEquivalent(
      "#473 per-group delivery (disjoint copies)",
      ["todo_pg1", "todo_pg2"],
      ["todo"],
    );
  }

  // #473 re-delivery: a second copy repeats an earlier Update after a new one.
  // The port must report only the newly-added Update, or the older put re-applies
  // and reverts the newer patch.
  {
    const dual = new DualRun();
    await dual.durable(
      mkAction({
        id: "a_rd",
        gsn: 6,
        hlc: hlc(1),
        updates: [putUpdate("todo_rd", "todo", { title: leaf("A", hlc(1), "u_a") }, "u_a")],
      }),
    );
    await dual.durable(
      mkAction({
        id: "a_rd",
        gsn: 6,
        hlc: hlc(2),
        updates: [
          {
            id: "u_b",
            subject_id: "todo_rd",
            subject_type: "todo",
            method: "patch",
            data: { fields: { note: leaf("B", hlc(2), "u_b") } },
          },
          putUpdate("todo_rd", "todo", { title: leaf("A", hlc(1), "u_a") }, "u_a"),
        ],
      }),
    );
    check(
      "#473 re-delivery: newer patch survives",
      dual.model.get("todo_rd")?.data.fields.note?.value === "B",
    );
    await dual.assertEquivalent("#473 re-delivery (dedup by update id)", ["todo_rd"], ["todo"]);
  }
};

// ---------------------------------------------------------------------------
// Merge policy: the overlay uses durable LWW, not pending-wins.
//
// `applyUpdate` / `mergeFieldValue` is the one merge the server also runs, so
// the optimistic overlay composes with it: a pending write that loses (older
// HLC, or an equal-HLC tiebreak the server's update_id wins) is not shown
// winning, because the server will settle on the other value and a pending-wins
// overlay would flip on ack. The client's `applyLocalUpdate` differs on exactly
// those cases; this section asserts the read model matches durable LWW and pins
// where `applyLocalUpdate` diverges.
// ---------------------------------------------------------------------------

const runMergeEquivalence = (): void => {
  section("Merge policy: overlay uses durable LWW (client applyLocalUpdate diverges)");
  const base: Entity = {
    id: "todo_1",
    type: "todo",
    data: { fields: { title: leaf("Hello", hlc(5), "u_mmm") } },
    created_hlc: hlc(5),
    updated_hlc: hlc(5),
    deleted_hlc: null,
    last_gsn: 3,
  };
  const probes: [string, Entity | null, Update, string][] = [
    [
      "put over existing",
      base,
      putUpdate("todo_1", "todo", { title: leaf("New", hlc(9), "u_new") }),
      hlc(9),
    ],
    [
      "put over null",
      null,
      putUpdate("todo_1", "todo", { title: leaf("New", hlc(9), "u_new") }),
      hlc(9),
    ],
    [
      "patch top field",
      base,
      patchUpdate("todo_1", { title: leaf("Newer", hlc(9), "u_new") }),
      hlc(9),
    ],
    [
      "patch over null",
      null,
      patchUpdate("todo_1", { title: leaf("Orphan", hlc(9), "u_new") }),
      hlc(9),
    ],
    [
      "map union",
      { ...base, data: { fields: { content: { map: { a: leaf("A", hlc(5), "u_a") } } } } },
      {
        id: "u_b",
        subject_id: "todo_1",
        subject_type: "todo",
        method: "patch",
        data: { fields: { content: { map: { b: leaf("B", hlc(9), "u_b") } } } },
      },
      hlc(9),
    ],
    ["delete", base, deleteUpdate("todo_1"), hlc(9)],
    // The cases that distinguish the overlay rule from durable LWW: a pending
    // write that ties (and loses the update_id tiebreak) or is older must still
    // win the optimistic view.
    [
      "patch equal HLC, loses update_id tiebreak",
      base,
      patchUpdate("todo_1", { title: leaf("Tie", hlc(5), "u_aaa") }),
      hlc(5),
    ],
    [
      "patch older HLC",
      base,
      patchUpdate("todo_1", { title: leaf("Old", hlc(4), "u_old") }),
      hlc(4),
    ],
  ];
  const strip = (entity: Entity | null): unknown =>
    entity === null
      ? null
      : {
          id: entity.id,
          type: entity.type,
          data: entity.data,
          updated_hlc: entity.updated_hlc,
          deleted_hlc: entity.deleted_hlc,
        };
  const title = (entity: Entity | null): unknown => {
    const field = entity?.data.fields.title;
    return field !== undefined && !("map" in field) ? field.value : undefined;
  };
  for (const [label, current, update, hlcString] of probes) {
    const model = createReadModel();
    if (current !== null) {
      model.loadSnapshot({ formatVersion: 1, position: 0, version: 0, entities: [current] });
    }
    model.optimistic(mkAction({ id: "a_opt", gsn: 0, hlc: hlcString, updates: [update] }));
    const overlay = model.get("todo_1");
    const durable = applyUpdate(current, update, 0, hlcString);
    check(`overlay == durable LWW: ${label}`, isDeepStrictEqual(strip(overlay), strip(durable)));
    const pending = applyLocalUpdate(current, update, hlcString);
    const diverges = !isDeepStrictEqual(strip(pending), strip(durable));
    const expectedDivergence =
      label === "patch equal HLC, loses update_id tiebreak" || label === "patch older HLC";
    check(
      expectedDivergence
        ? `applyLocalUpdate diverges (pending-wins): ${label}`
        : `applyLocalUpdate agrees: ${label}`,
      diverges === expectedDivergence,
    );
    if (diverges) {
      console.log(
        `  [!] ${label}: durable LWW=${String(title(durable))} vs applyLocalUpdate=${String(title(pending))}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Snapshot / hydrate: snapshot + tail ≡ incremental fold; gsn-0 survives.
// ---------------------------------------------------------------------------

const runHydrate = async (): Promise<void> => {
  section("Hydrate = latest snapshot + log tail");
  const incremental = createReadModel();
  const incrementalPorts = new MemoryPorts();

  const actions: Action[] = [
    mkAction({
      id: "a1",
      gsn: 0,
      hlc: hlc(1),
      updates: [putUpdate("todo_a", "todo", { title: leaf("A", hlc(1), "u_a") })],
    }),
    mkAction({
      id: "a2",
      gsn: 5,
      hlc: hlc(2),
      updates: [putUpdate("todo_b", "todo", { title: leaf("B", hlc(2), "u_b") })],
    }),
  ];
  for (const action of actions) await ingestDurable(incremental, incrementalPorts, action);
  // take the snapshot after a1+a2, then append a third action to the log only
  const snapshot = incremental.toSnapshot();
  const snapshotPorts = new MemoryPorts();
  await snapshotPorts.snapshots.save(snapshot);
  const logged = await incrementalPorts.actions.readTail(0);
  for (const entry of logged) await snapshotPorts.actions.append(entry.action);
  const tailAction = mkAction({
    id: "a3",
    gsn: 6,
    hlc: hlc(3),
    updates: [patchUpdate("todo_b", { title: leaf("B2", hlc(3), "u_b2") })],
  });
  await ingestDurable(incremental, incrementalPorts, tailAction);
  await snapshotPorts.actions.append(tailAction);

  const rehydrated = createReadModel();
  await hydrate(rehydrated, snapshotPorts);
  check(
    "hydrate: snapshot + tail == incremental fold",
    isDeepStrictEqual(byId(rehydrated.iterate("todo")), byId(incremental.iterate("todo"))),
  );
  // Archives of the reason for the position cursor: the gsn-0 put must survive.
  check(
    "hydrate: gsn-0 backfill put survives (position cursor)",
    rehydrated.get("todo_a") !== null,
  );

  // Full replay (no snapshot) must also match.
  const fullReplay = createReadModel();
  await hydrate(fullReplay, incrementalPorts);
  check(
    "hydrate: no snapshot, full log replay == incremental fold",
    isDeepStrictEqual(byId(fullReplay.iterate("todo")), byId(incremental.iterate("todo"))),
  );

  // Optimistic outbox projection survives a reload.
  const optimisticPorts = new MemoryPorts();
  await optimisticPorts.actions.append(actions[0]!);
  const pending = mkAction({
    id: "a_pending",
    gsn: 0,
    hlc: hlc(9),
    updates: [patchUpdate("todo_a", { title: leaf("Pending", hlc(9), "u_p") })],
  });
  optimisticPorts.outboxEntries.push({ action: pending, status: "pending" });
  const hydratedPending = createReadModel();
  await hydrate(hydratedPending, optimisticPorts);
  check(
    "hydrate: durable outbox replays into the optimistic overlay",
    hydratedPending.get("todo_a")?.data.fields.title?.value === "Pending",
  );

  // An orphan across a snapshot: a patch arrives, a snapshot is taken before its
  // base is appended, and the rebuilt model must still reconcile the patch.
  {
    const live = createReadModel();
    const ports = new MemoryPorts();
    const patchEntry = await ports.actions.append(
      mkAction({
        id: "h_orphan_patch",
        gsn: 2,
        hlc: hlc(9),
        updates: [patchUpdate("todo_orphan", { title: leaf("InFlight", hlc(9), "u_op") })],
      }),
    );
    live.ingest(patchEntry.action, patchEntry.position);
    const orphaned = live.toSnapshot();
    check("orphan snapshot: watermark held before the orphan", orphaned.position === 0);
    await ports.snapshots.save(orphaned);
    const baseEntry = await ports.actions.append(
      mkAction({
        id: "h_orphan_base",
        gsn: 0,
        hlc: hlc(5),
        updates: [putUpdate("todo_orphan", "todo", { title: leaf("Server", hlc(5), "u_ob") })],
      }),
    );
    live.ingest(baseEntry.action, baseEntry.position);
    const rebuilt = createReadModel();
    await hydrate(rebuilt, ports);
    check(
      "orphan snapshot: rebuilt equals incremental",
      isDeepStrictEqual(rebuilt.get("todo_orphan"), live.get("todo_orphan")),
    );
    check(
      "orphan snapshot: in-flight patch survives",
      rebuilt.get("todo_orphan")?.data.fields.title?.value === "InFlight",
    );
  }
};

// ---------------------------------------------------------------------------
// Fuzz: durable ops must stay equivalent across a long random sequence, and
// optimistic-then-echo must converge.
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const runFuzz = async (): Promise<void> => {
  section("Fuzz (seeded): durable + optimistic-then-echo convergence");
  const rand = mulberry32(0x496);
  const dual = new DualRun();
  const ids = ["f_0", "f_1", "f_2", "f_3", "f_4"];
  const types = ["todo", "note"];
  let gsn = 0;
  let mismatches = 0;

  for (let step = 0; step < 300; step++) {
    const id = ids[Math.floor(rand() * ids.length)]!;
    const type = types[Math.floor(rand() * types.length)]!;
    const hlcString = hlc(step + 1);
    const roll = rand();
    const actionId = `af_${step}`;
    const updateId = `uf_${step}`;
    let update: Update;
    if (roll < 0.4) {
      const fields: Record<string, FieldValue> = { title: leaf(`t${step}`, hlcString, updateId) };
      if (rand() < 0.5) {
        fields.content = { map: { [`k${step % 3}`]: leaf(step, hlcString, `${updateId}_m`) } };
      }
      update = putUpdate(id, type, fields, updateId);
    } else if (roll < 0.85) {
      update = patchUpdate(id, { title: leaf(`t${step}`, hlcString, updateId) }, updateId);
    } else {
      update = deleteUpdate(id, updateId);
    }
    gsn += 1;
    const durable = mkAction({ id: actionId, gsn, hlc: hlcString, updates: [update] });
    const optimistic = rand() < 0.25;
    if (optimistic) {
      // An optimistic write is always echoed immediately, so the known
      // "overlay vs re-materialize on an unrelated action" divergence cannot fire.
      await dual.optimistic({ ...durable, gsn: 0 });
      await dual.durable(durable);
    } else {
      await dual.durable(durable);
    }
    const mine = dual.model.get(id);
    const theirs = await dual.adapter.entities.get(id);
    if (!isDeepStrictEqual(mine, theirs)) mismatches += 1;
  }
  check("fuzz: 300 random ops stay equivalent", mismatches === 0, `${mismatches} mismatches`);
};

// ---------------------------------------------------------------------------
// Divergence probe (finding, not a required case): an optimistic write on an
// entity is silently dropped by the current adapter when an unrelated durable
// Action touches that entity before the echo.
// ---------------------------------------------------------------------------

const runDivergenceProbe = async (): Promise<void> => {
  section("Divergence probe (finding)");
  const dual = new DualRun();
  // The local write is newer (hlc 3) than the interfering durable action
  // (hlc 2), so the optimistic view should keep it until echo/conflict.
  const local = mkAction({
    id: "a_local",
    gsn: 0,
    hlc: hlc(3),
    updates: [patchUpdate("todo_x", { title: leaf("Local", hlc(3), "u_local") })],
  });
  // Base row must exist first.
  await dual.durable(
    mkAction({
      id: "a_base",
      gsn: 1,
      hlc: hlc(1),
      updates: [putUpdate("todo_x", "todo", { title: leaf("Base", hlc(1), "u_base") })],
    }),
  );
  await dual.optimistic(local);
  // Unrelated durable action on the same entity, before the echo. It is older
  // than the local write, so it must not clobber it.
  await dual.durable(
    mkAction({
      id: "a_other",
      gsn: 2,
      hlc: hlc(2),
      updates: [patchUpdate("todo_x", { title: leaf("Other", hlc(2), "u_other") })],
    }),
  );
  const mine = dual.model.get("todo_x")?.data.fields.title?.value;
  const theirs = (await dual.adapter.entities.get("todo_x"))?.data.fields.title?.value;
  check("divergence: read model keeps the newer local write", mine === "Local");
  check("divergence: adapter drops it (known defect)", theirs === "Other");
  console.log(`  [!] read-model title = ${String(mine)} (overlay kept, newer HLC)`);
  console.log(`  [!] adapter    title = ${String(theirs)} (overlay dropped by re-materialize)`);
};

// ---------------------------------------------------------------------------
// #495 budget check: 10k metadata docs, in-process.
// ---------------------------------------------------------------------------

const runBudgetCheck = (): void => {
  section("#495 budget check (10k metadata docs, in-process)");
  const N = 10_000;
  const BRANCH = 10;
  const REFS = 2;
  // The #495 reference generator omitted the optional per-leaf `hlc`, so match
  // that shape: the 15.1 MB figure is for rows without per-leaf HLCs.
  const leaf = (value: unknown, _hlcString: string, updateId: string): FieldValue => ({
    value,
    update_id: updateId,
  });
  // Same reason: the reference entities carried the placeholder HLC "1".
  const hlc = (): string => "1";
  const buildStart = performance.now();
  const model = createReadModel();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const backlinks = new Map<string, string[]>();
  const references = new Map<string, string[]>();

  const readString = (entity: Entity, field: string): string | null => {
    const value = entity.data.fields[field];
    if (value === undefined || "map" in value) return null;
    return typeof value.value === "string" ? value.value : null;
  };

  let gsn = 0;
  for (let i = 0; i < N; i++) {
    gsn += 1;
    model.ingest(
      mkAction({
        id: `ap_${i}`,
        gsn,
        hlc: hlc(i),
        updates: [
          putUpdate(`page_${i}`, "page", {
            title: leaf(`Document ${i} — a page in a very large workspace`, hlc(i), `ut_${i}`),
            icon: leaf("📄", hlc(i), `ui_${i}`),
            updated_at: leaf(1_700_000_000_000 + i, hlc(i), `uu_${i}`),
          }),
        ],
      }),
      i + 1,
    );
  }
  // relationships: parent + references
  for (let i = 0; i < N; i++) {
    if (i > 0) {
      const target = Math.floor((i - 1) / BRANCH);
      model.ingest(
        mkAction({
          id: `arp_${i}`,
          gsn: ++gsn,
          hlc: hlc(i),
          updates: [
            putUpdate(`rel_parent_${i}`, "relationship", {
              source_id: leaf(`page_${i}`, hlc(i), `us_${i}`),
              target_id: leaf(`page_${target}`, hlc(i), `utg_${i}`),
              type: leaf("page", hlc(i), `uty_${i}`),
              field: leaf("parent", hlc(i), `uf_${i}`),
            }),
          ],
        }),
        ++gsn,
      );
    }
    for (let r = 0; r < REFS; r++) {
      const target = (i * 7 + r * 13 + 1) % N;
      model.ingest(
        mkAction({
          id: `arr_${i}_${r}`,
          gsn: ++gsn,
          hlc: hlc(i),
          updates: [
            putUpdate(`rel_ref_${i}_${r}`, "relationship", {
              source_id: leaf(`page_${i}`, hlc(i), `us_${i}_${r}`),
              target_id: leaf(`page_${target}`, hlc(i), `utr_${i}_${r}`),
              type: leaf("page", hlc(i), `utyr_${i}_${r}`),
              field: leaf("references", hlc(i), `ufr_${i}_${r}`),
            }),
          ],
        }),
        ++gsn,
      );
    }
    model.ingest(
      mkAction({
        id: `aeg_${i}`,
        gsn: ++gsn,
        hlc: hlc(i),
        updates: [
          putUpdate(`eg_${i}`, "entityGroup", {
            entity_id: leaf(`page_${i}`, hlc(i), `uea_${i}`),
            group_id: leaf("grp_ws", hlc(i), `ueg_${i}`),
          }),
        ],
      }),
      ++gsn,
    );
  }
  const buildMs = performance.now() - buildStart;

  // Footprint of the resident metadata (the read model's own snapshot).
  const metadataBytes = Buffer.byteLength(JSON.stringify(model.toSnapshot().entities));
  // Build adjacency (the projection #497 will maintain incrementally).
  const projectionStart = performance.now();
  for (const row of model.iterate("relationship")) {
    if (row.deleted_hlc !== null) continue;
    const source = readString(row, "source_id");
    const target = readString(row, "target_id");
    const field = readString(row, "field");
    if (source === null || target === null) continue;
    if (field === "parent") {
      parent.set(source, target);
      push(children, target, source);
    } else if (field === "references") {
      push(backlinks, target, source);
      push(references, source, target);
    }
  }
  const projectionMs = performance.now() - projectionStart;
  // Full tree build: adjacency + N parent reads.
  const treeStart = performance.now();
  let visited = 0;
  for (let i = 0; i < N; i++) if (parent.get(`page_${i}`) !== undefined || i === 0) visited += 1;
  const treeMs = performance.now() - treeStart + projectionMs;
  check("budget: tree traversal covered every page", visited === N);

  console.log(`  build ${N.toLocaleString()} metadata rows: ${buildMs.toFixed(0)} ms`);
  console.log(
    `  resident footprint: ${(metadataBytes / 1024 / 1024).toFixed(1)} MB   (target ~15.1 MB)`,
  );
  console.log(`  adjacency build: ${projectionMs.toFixed(1)} ms`);
  console.log(`  full tree build (adjacency + N reads): ${treeMs.toFixed(1)} ms   (target ~40 ms)`);
  check(
    "budget: footprint in the ~15 MB band",
    metadataBytes > 13_000_000 && metadataBytes < 18_000_000,
  );
  check("budget: full tree build < 250 ms", treeMs < 250);
};

// ---------------------------------------------------------------------------
// Write-path probe: the normative merge copies the whole map on every patch.
// The 495 budget was read-focused; this checks the resident model's write path
// for a collaborative-text-sized map field (N run keys), including the
// contentChanged overhead the model adds on top of applyUpdate.
// ---------------------------------------------------------------------------

const runWritePathProbe = (): void => {
  section("Write-path probe: one-key patch to an N-key map field");
  const N = 1000;
  const map: Record<string, FieldValue> = {};
  for (let k = 0; k < N; k++) map[`k${k}`] = leaf(String(k), hlc(0), `uk_${k}`);
  const baseEntity: Entity = {
    id: "doc_w",
    type: "doc",
    data: { fields: { content: { map } } },
    created_hlc: hlc(0),
    updated_hlc: hlc(0),
    deleted_hlc: null,
    last_gsn: 1,
  };
  const probePatch = (hlcString: string, updateId: string): Update => ({
    id: updateId,
    subject_id: "doc_w",
    subject_type: "doc",
    method: "patch",
    data: { fields: { content: { map: { k0: leaf("x", hlcString, updateId) } } } },
  });
  const ITER = 500;
  let sink: unknown = 0;
  const bench = (fn: (i: number) => void): number => {
    for (let i = 0; i < 100; i++) fn(i);
    const start = performance.now();
    for (let i = 0; i < ITER; i++) fn(i);
    return ((performance.now() - start) / ITER) * 1000;
  };

  let entity: Entity | null = baseEntity;
  const applyUs = bench((i) => {
    entity = applyUpdate(entity, probePatch(hlc(1 + i), `uw_${i}`), 0, hlc(1 + i));
    sink = entity;
  });
  const winningModel = createReadModel();
  winningModel.loadSnapshot({ formatVersion: 1, position: 0, version: 0, entities: [baseEntity] });
  const winningUs = bench((i) => {
    winningModel.ingest(
      mkAction({
        id: `aw_${i}`,
        gsn: 0,
        hlc: hlc(1 + i),
        updates: [probePatch(hlc(1 + i), `uw_${i}`)],
      }),
      i + 1,
    );
    sink = winningModel;
  });
  // A losing patch keeps updated_hlc, so contentChanged falls through to a full
  // structural scan of the map.
  const losingModel = createReadModel();
  losingModel.loadSnapshot({
    formatVersion: 1,
    position: 0,
    version: 0,
    entities: [{ ...baseEntity, updated_hlc: hlc(1_000_000) }],
  });
  const losingUs = bench((i) => {
    losingModel.ingest(
      mkAction({ id: `al_${i}`, gsn: 0, hlc: hlc(1), updates: [probePatch(hlc(1), `ul_${i}`)] }),
      i + 1,
    );
    sink = losingModel;
  });

  console.log(`  applyUpdate (winning), N=${N}:          ${applyUs.toFixed(0)} µs/op`);
  console.log(
    `  read-model ingest (winning):           ${winningUs.toFixed(0)} µs/op  (+${((winningUs / applyUs - 1) * 100).toFixed(0)}%)`,
  );
  console.log(`  read-model ingest (losing, full scan):  ${losingUs.toFixed(0)} µs/op`);
  check("write path: winning ingest within 2.5x of applyUpdate", winningUs < applyUs * 2.5);
  console.log(
    "  [!] mergeFields/mergeFieldValue copy the whole map per patch; V8's property cliff makes that O(N) and steep (see spec §8.8).",
  );
  void sink;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  console.log("#496 read-model / durability seam — throwaway dual-run prototype");
  console.log("Resident read model (mutable core + versioned handle) vs createMemoryAdapter().");
  await runRequiredCases();
  runMergeEquivalence();
  await runHydrate();
  await runFuzz();
  await runDivergenceProbe();
  runBudgetCheck();
  runWritePathProbe();

  section("Summary");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  failures:\n    - ${failures.join("\n    - ")}`);
    process.exitCode = 1;
  }
};

void main();
