/**
 * Differential test for dispatch conservatism (#1002).
 *
 * A subscription that reads an index is only worth narrowing if dispatch still
 * hands it every change its result observes. This test does not inspect the
 * index tables: it keeps a live result for a set of queries, applies random
 * writes, and compares each retained result with a fresh run of the same query
 * against the same replica. A mismatch is a missed touch (or a retained result
 * that refused a change it needed), which is the failure this guards against.
 *
 * The fixture is deliberately small and the generator seeded, so a failure
 * names the query, the write, and the step that exposed it.
 */

import { describe, expect, it } from "vitest";
import {
  carriesComponent,
  isFieldMap,
  makeHlc,
  systemValueString,
  type Entity,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { createReplica, REPLICA_RECORD_FORMAT, type Replica } from "@ebbjs/storage/replica";

import { componentRowView } from "../system-row";
import { createReplicaExecutor, executePlan } from "../query-execute";
import { planQuery } from "../query-plan";
import { createQueryResults } from "../query-results";
import { createSubscriptionRegistry } from "../subscriptions";
import type { Query } from "../query";
import type { Join } from "../query";
import type { QuerySelection } from "../selection";

const BASE_HLC = 1_700_000_000_000;
const STEP_MS = 1;

const leaf = (value: unknown, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(BASE_HLC),
});

const entity = (id: string, model: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  model,
  data: { fields },
  exists: true,
  created_hlc: makeHlc(BASE_HLC),
  updated_hlc: makeHlc(BASE_HLC),
  deleted_hlc: null,
  last_gsn: 0,
});

const linkField = (
  edges: readonly { readonly as: string; readonly type: string; readonly target: string }[],
): FieldValue => {
  const byAs: Record<string, Record<string, Record<string, FieldValue>>> = {};
  for (const edge of edges) {
    const byType = (byAs[edge.as] ??= {});
    const byTarget = (byType[edge.type] ??= {});
    byTarget[edge.target] = leaf(true, `u_link_${edge.as}_${edge.target}`);
  }
  return {
    map: Object.fromEntries(
      Object.entries(byAs).map(([as, byType]) => [
        as,
        {
          map: Object.fromEntries(
            Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
          ),
        },
      ]),
    ),
  };
};

const membershipField = (entityId: string, groupId: string): FieldValue =>
  leaf({ entity_id: entityId, group_id: groupId }, `u_membership_${entityId}`);

/** The shape each model projects when a read selects nothing. */
const shape: Readonly<Record<string, readonly string[]>> = {
  page: ["title", "status"],
  user: ["name"],
  label: ["name"],
  todo: ["title", "due"],
  ebb: [],
};

const selection = (model: string, fields: readonly string[]): QuerySelection => ({
  fields,
  components: fields.map((field) => `${model}/${field}`),
});

const relationship = (
  as: string,
  type: string,
  anyOf: readonly string[] | null,
): Extract<Query["groups"][number][number], { kind: "relationship" }> => ({
  kind: "relationship",
  as,
  type,
  anyOf,
});

const forward = (
  as: string,
  type: string,
  target: string,
  cardinality: "one" | "many" = "one",
): Join => ({ kind: "relationship", as, type, target, direction: "forward", cardinality });

const reverse = (as: string, type: string, target: string): Join => ({
  kind: "relationship",
  as,
  type,
  target,
  direction: "reverse",
  cardinality: "many",
});

const groupsJoin: Join = {
  kind: "membership",
  as: "groups",
  target: "ebb",
  cardinality: "many",
};

const query = (overrides: Partial<Query> & Pick<Query, "source">): Query => ({
  groups: [],
  order: null,
  limit: null,
  joins: [],
  ...overrides,
});

/** One fixture, loaded directly: no actions, no journal to replay. */
const fixture = (): Replica => {
  const replica = createReplica();
  const entities: Entity[] = [
    entity("page_0", "page", {
      title: leaf("Alpha", "u_page_0_title"),
      status: leaf("open", "u_page_0_status"),
      link: linkField([
        { as: "assignee", type: "page", target: "user_0" },
        { as: "tags", type: "page", target: "label_0" },
        { as: "tags", type: "page", target: "label_1" },
      ]),
    }),
    entity("page_1", "page", {
      title: leaf("Beta", "u_page_1_title"),
      status: leaf("open", "u_page_1_status"),
      link: linkField([
        { as: "assignee", type: "page", target: "user_1" },
        { as: "parent", type: "page", target: "page_0" },
      ]),
    }),
    entity("page_2", "page", {
      title: leaf("Gamma", "u_page_2_title"),
      status: leaf("open", "u_page_2_status"),
      link: linkField([
        { as: "assignee", type: "page", target: "user_0" },
        { as: "parent", type: "page", target: "page_1" },
      ]),
    }),
    entity("page_3", "page", {
      title: leaf("Delta", "u_page_3_title"),
      status: leaf("open", "u_page_3_status"),
    }),
    entity("user_0", "user", { name: leaf("Ada", "u_user_0") }),
    entity("user_1", "user", { name: leaf("Grace", "u_user_1") }),
    entity("user_2", "user", { name: leaf("Linus", "u_user_2") }),
    entity("label_0", "label", { name: leaf("bug", "u_label_0") }),
    entity("label_1", "label", { name: leaf("docs", "u_label_1") }),
    entity("label_2", "label", { name: leaf("chore", "u_label_2") }),
    entity("todo_0", "todo", {
      title: leaf("Write", "u_todo_0_title"),
      due: leaf(1, "u_todo_0_due"),
    }),
    entity("todo_1", "todo", {
      title: leaf("Review", "u_todo_1_title"),
      due: leaf(2, "u_todo_1_due"),
    }),
    entity("todo_2", "todo", { title: leaf("Ship", "u_todo_2_title") }),
    entity("eg_0", "ebb", { membership: membershipField("todo_0", "g_1") }),
    entity("eg_1", "ebb", { membership: membershipField("todo_1", "g_2") }),
    entity("eg_2", "ebb", { membership: membershipField("page_0", "g_1") }),
    entity("eg_3", "ebb", { membership: membershipField("page_1", "g_2") }),
    entity("eg_4", "ebb", { membership: membershipField("page_2", "g_1") }),
  ];
  replica.load({
    format: REPLICA_RECORD_FORMAT,
    position: 0,
    revision: 0,
    entities,
    componentVersions: {},
  });
  return replica;
};

/** Project a row exactly as the read surface would, for a fresh-run oracle. */
const project = (replica: Replica, run: Query, row: Entity): Record<string, unknown> => {
  const fields = run.selected?.fields ?? shape[row.model] ?? [];
  const out: Record<string, unknown> = {
    id: row.id,
    groupIds: replica.memberships({ entityId: row.id }),
  };
  for (const field of fields) {
    const value = row.data.fields[field];
    if (value === undefined) continue;
    out[field] = isFieldMap(value) ? value.map : value.value;
  }
  for (const join of run.joins) {
    const ids =
      join.kind === "membership"
        ? replica.memberships({ entityId: row.id })
        : replica.relationships({
            as: join.as,
            type: join.type,
            ...(join.direction === "forward" ? { sourceId: row.id } : { targetId: row.id }),
          });
    const rows = ids.flatMap((id) => {
      const target = replica.get(id);
      if (target === undefined || target.deleted_hlc !== null) return [];
      if (join.kind === "membership") {
        if (!carriesComponent(target, "group")) return [];
        const view = componentRowView(target, "group");
        return view === null ? [] : [view];
      }
      if (target.model !== join.target) return [];
      const projected: Record<string, unknown> = { id: target.id };
      for (const field of shape[target.model] ?? []) {
        const value = target.data.fields[field];
        if (value !== undefined) projected[field] = isFieldMap(value) ? value.map : value.value;
      }
      return [projected];
    });
    out[join.as] = join.cardinality === "one" ? (rows[0] ?? null) : rows;
  }
  return out;
};

const runQuery = (replica: Replica, run: Query): readonly unknown[] =>
  executePlan(planQuery(run), createReplicaExecutor(replica)).map((row) =>
    project(replica, run, row),
  );

const QUERIES: readonly { readonly name: string; readonly query: Query }[] = [
  {
    name: "assignee=user_0",
    query: query({
      source: "page",
      groups: [[relationship("assignee", "page", ["user_0"])]],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "assignee∈{user_0,user_1}",
    query: query({
      source: "page",
      groups: [[relationship("assignee", "page", ["user_0", "user_1"])]],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "assignee=user_0 + join",
    query: query({
      source: "page",
      groups: [[relationship("assignee", "page", ["user_0"])]],
      joins: [forward("assignee", "page", "user")],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "assignee=user_0 OR status=open + join",
    query: query({
      source: "page",
      groups: [
        [relationship("assignee", "page", ["user_0"])],
        [{ kind: "field", field: "status", value: "open" }],
      ],
      joins: [forward("assignee", "page", "user")],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "tags=label_0 + many join",
    query: query({
      source: "page",
      groups: [[relationship("tags", "page", ["label_0"])]],
      joins: [forward("tags", "page", "label", "many")],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "parent=page_0 + one join",
    query: query({
      source: "page",
      groups: [[relationship("parent", "page", ["page_0"])]],
      joins: [forward("parent", "page", "page")],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "children (reverse join)",
    query: query({
      source: "page",
      joins: [reverse("parent", "page", "page")],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "has(due)",
    query: query({
      source: "todo",
      groups: [[{ kind: "existence", component: "todo/due", present: true }]],
      selected: selection("todo", ["title"]),
    }),
  },
  {
    name: "hasNot(due)",
    query: query({
      source: "todo",
      groups: [[{ kind: "existence", component: "todo/due", present: false }]],
      selected: selection("todo", ["title"]),
    }),
  },
  {
    name: "groups=g_1",
    query: query({
      source: "todo",
      groups: [[{ kind: "membership", anyOf: ["g_1"] }]],
      selected: selection("todo", ["title"]),
    }),
  },
  {
    name: "page + groups join",
    query: query({
      source: "page",
      groups: [[{ kind: "membership", anyOf: ["g_1"] }]],
      joins: [groupsJoin],
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "status=open ordered",
    query: query({
      source: "page",
      groups: [[{ kind: "field", field: "status", value: "open" }]],
      order: { field: "title", direction: "asc" },
      selected: selection("page", ["title"]),
    }),
  },
  {
    name: "all pages",
    query: query({ source: "page" }),
  },
];

interface Watched {
  readonly name: string;
  readonly query: Query;
  readonly store: ReturnType<ReturnType<typeof createQueryResults>["watch"]>;
  readonly unsubscribe: () => void;
}

/** A deterministic PRNG, so a failure can be replayed from its seed. */
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Harness {
  readonly replica: Replica;
  readonly watched: readonly Watched[];
  readonly ingest: (updates: readonly Update[]) => void;
  readonly close: () => void;
}

const harness = (): Harness => {
  const replica = fixture();
  const registry = createSubscriptionRegistry(replica, { residencyTtlMs: 0 });
  const results = createQueryResults(replica, registry);
  const watched = QUERIES.map(({ name, query: run }) => {
    const source = {
      ready: () => {},
      isReady: () => true,
      execute: () => runQuery(replica, run),
    };
    const store = results.watch("rows", run, source);
    const unsubscribe = store.subscribe(() => {});
    return { name, query: run, store, unsubscribe };
  });
  let position = 0;
  const ingest = (updates: readonly Update[]): void => {
    position += 1;
    const hlc = makeHlc(BASE_HLC + position * STEP_MS);
    replica.ingest(
      { id: `a_${position}`, actor_id: "actor_1", hlc, gsn: position, updates: [] },
      updates,
      position,
    );
  };
  return {
    replica,
    watched,
    ingest,
    close: () => {
      for (const { unsubscribe } of watched) unsubscribe();
      registry.close();
    },
  };
};

const check = (h: Harness, label: string): void => {
  for (const { name, query: run, store } of h.watched) {
    const snapshot = store.getSnapshot();
    expect(snapshot.status, `${name}: ${label}`).toBe("current");
    expect(snapshot.data, `${name}: ${label}`).toEqual(runQuery(h.replica, run));
  }
};

/** Live ids of a model, ascending, so a write always targets a real row. */
const idsOf = (replica: Replica, model: string): readonly string[] =>
  replica.iterate(model).map((row) => row.id);

const pick = <T>(random: () => number, values: readonly T[]): T | undefined =>
  values.length === 0 ? undefined : values[Math.floor(random() * values.length)];

const change = (
  subject: string,
  component: string,
  method: "replace" | "drop" | "merge",
  data: unknown,
  sequence: number,
): Update =>
  ({
    id: `u_${sequence}_${component}_${method}`,
    subject_id: subject,
    component,
    method,
    data,
  }) as Update;

const linkChange = (
  subject: string,
  as: string,
  type: string,
  target: string,
  present: boolean,
  sequence: number,
): Update =>
  change(
    subject,
    "ebb/link",
    "merge",
    {
      map: {
        [as]: {
          map: {
            [type]: {
              map: {
                [target]: {
                  value: present ? true : null,
                  update_id: `u_${sequence}_edge`,
                  hlc: makeHlc(BASE_HLC + sequence * STEP_MS),
                },
              },
            },
          },
        },
      },
    },
    sequence,
  );

let sequence = 0;

/** A monotonic HLC for the writes this test builds by hand. */
const nextHlc = (): string => makeHlc(BASE_HLC + 1_000_000 + sequence * STEP_MS);

/** One random write, applied through the replica's own mutating calls. */
const step = (h: Harness, random: () => number): string => {
  const replica = h.replica;
  const kind = Math.floor(random() * 9);
  const pages = idsOf(replica, "page");
  const todos = idsOf(replica, "todo");
  const users = idsOf(replica, "user");
  const labels = idsOf(replica, "label");
  const membershipRows = idsOf(replica, "ebb");
  const total = replica.stats().entities;

  if (kind === 0) {
    const subject = pick(random, [...pages, ...todos, ...users, ...labels]);
    if (subject === undefined) return "value: no rows";
    const row = replica.get(subject);
    const fields = Object.entries(shape[row?.model ?? ""] ?? []);
    const field = fields[Math.floor(random() * fields.length)]?.[0];
    if (!field) return "value: no fields";
    sequence += 1;
    const value = field === "due" ? sequence : `v${sequence}`;
    h.ingest([
      change(
        subject,
        `${row?.model}/${field}`,
        "replace",
        { value, update_id: `u_${sequence}`, hlc: nextHlc() },
        sequence,
      ),
    ]);
    return `value ${row?.model}/${field} on ${subject}`;
  }

  if (kind === 1) {
    const subject = pick(random, todos);
    if (subject === undefined || replica.get(subject)?.data.fields.due === undefined) {
      return "drop due: none";
    }
    sequence += 1;
    h.ingest([change(subject, "todo/due", "drop", null, sequence)]);
    return `drop todo/due on ${subject}`;
  }

  if (kind === 2 || kind === 3) {
    const subject = pick(random, pages);
    if (subject === undefined) return "link: no pages";
    const edge =
      random() < 0.5
        ? { as: "assignee", type: "page", targets: users }
        : random() < 0.5
          ? { as: "tags", type: "page", targets: labels }
          : { as: "parent", type: "page", targets: pages };
    sequence += 1;
    if (kind === 2) {
      const target = pick(random, edge.targets);
      if (target === undefined) return "link add: no target";
      h.ingest([linkChange(subject, edge.as, edge.type, target, true, sequence)]);
      return `link ${edge.as} += ${target} on ${subject}`;
    }
    const current = replica.relationships({ as: edge.as, type: edge.type, sourceId: subject });
    const target = pick(random, current);
    if (target === undefined) return "link remove: no edge";
    h.ingest([linkChange(subject, edge.as, edge.type, target, false, sequence)]);
    return `link ${edge.as} -= ${target} on ${subject}`;
  }

  if (kind === 4) {
    // A membership row refiled: the entity row is untouched, so the only
    // dispatch signal is the `ebb/membership` component and the `ebb` source.
    const row = pick(random, membershipRows);
    if (row === undefined) return "membership refile: no rows";
    const entityId = systemValueString(replica.get(row), "membership", "entity_id");
    if (entityId === null || entityId.length === 0) return "membership refile: no entity";
    const group = random() < 0.5 ? "g_1" : "g_2";
    sequence += 1;
    h.ingest([
      change(
        row,
        "ebb/membership",
        "replace",
        {
          value: { entity_id: entityId, group_id: group },
          update_id: `u_${sequence}`,
          hlc: nextHlc(),
        },
        sequence,
      ),
    ]);
    return `membership row ${row} for ${entityId} -> ${group}`;
  }

  if (kind === 5) {
    // A membership row: create, refile, or delete. It changes the entity's
    // groups without touching the entity row.
    const existing = pick(random, membershipRows);
    const entityId = pick(random, [...todos, ...pages]);
    if (entityId === undefined) return "membership row: no entity";
    sequence += 1;
    const group = random() < 0.5 ? "g_1" : "g_2";
    const rowId = existing ?? `eg_new_${sequence}`;
    const updates: Update[] = [];
    if (existing === undefined || replica.get(rowId) === undefined) {
      updates.push({
        id: `u_${sequence}_create`,
        subject_id: rowId,
        model: "ebb",
        method: "create",
        hlc: makeHlc(BASE_HLC + sequence * STEP_MS),
        data: null,
      });
    }
    if (existing !== undefined && random() < 0.35) {
      updates.push({
        id: `u_${sequence}_delete`,
        subject_id: rowId,
        method: "delete",
        data: null,
      });
    } else {
      updates.push(
        change(
          rowId,
          "ebb/membership",
          "replace",
          {
            value: { entity_id: entityId, group_id: group },
            update_id: `u_${sequence}`,
            hlc: nextHlc(),
          },
          sequence,
        ),
      );
    }
    h.ingest(updates);
    return `membership row ${rowId} for ${entityId} in ${group}`;
  }

  if (kind === 6) {
    sequence += 1;
    const model = random() < 0.5 ? "page" : "todo";
    const subject = `new_${model}_${sequence}`;
    const fields: Record<string, unknown> =
      model === "page"
        ? { title: `New ${sequence}`, status: "open" }
        : { title: `New ${sequence}`, due: sequence };
    const updates: Update[] = [
      {
        id: `u_${sequence}_create`,
        subject_id: subject,
        model,
        method: "create",
        hlc: makeHlc(BASE_HLC + sequence * STEP_MS),
        data: null,
      },
      ...Object.entries(fields).map(([field, value]) =>
        change(
          subject,
          `${model}/${field}`,
          "replace",
          { value, update_id: `u_${sequence}_${field}`, hlc: nextHlc() },
          sequence,
        ),
      ),
    ];
    h.ingest(updates);
    return `create ${model} ${subject}`;
  }

  if (kind === 7 && total > 6) {
    const subject = pick(random, [...pages, ...todos, ...users, ...labels]);
    if (subject === undefined) return "delete: no rows";
    sequence += 1;
    h.ingest([{ id: `u_${sequence}_delete`, subject_id: subject, method: "delete", data: null }]);
    return `delete ${subject}`;
  }

  if (kind === 8 && total > 8) {
    const subject = pick(random, [...pages, ...todos, ...users, ...labels]);
    if (subject === undefined) return "evict: no rows";
    replica.evict([subject]);
    return `evict ${subject}`;
  }

  return "skipped";
};

/**
 * Writes that each target one of the narrowing rules, before the random loop.
 * A mutation of `relationCovers` that covers the join in an unpinned OR group,
 * or of `relationSubjects` that drops target-row changes, has to fail here.
 */
const knownMisses = (h: Harness, after: (label: string) => void): readonly string[] => {
  const labels: string[] = [];
  const write = (label: string, updates: readonly Update[]): void => {
    sequence += 1;
    h.ingest(updates);
    labels.push(label);
    after(label);
  };
  const hlc = nextHlc();
  // A joined target outside the predicate's anyOf, reached through the other OR
  // group. Only correct if the join keeps its target model dependency.
  const dnf = h.watched.find((entry) => entry.name.includes("OR"));
  if (dnf === undefined) throw new Error("no DNF query");
  const dnfBefore = runQuery(h.replica, dnf.query);
  write("user_1 name (DNF status group)", [
    change(
      "user_1",
      "user/name",
      "replace",
      { value: "Grace Hopper", update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);

  expect(runQuery(h.replica, dnf.query), "the user_1 write must change the DNF result").not.toEqual(
    dnfBefore,
  );
  expect(dnf.store.getSnapshot().data, "the DNF result must follow the write").toEqual(
    runQuery(h.replica, dnf.query),
  );
  // The predicate target itself, covered by the relation index.
  const covered = h.watched.find((entry) => entry.name === "assignee=user_0 + join");
  if (covered === undefined) throw new Error("no covered-join query");
  const coveredBefore = runQuery(h.replica, covered.query);
  write("user_0 name (covered join target)", [
    change(
      "user_0",
      "user/name",
      "replace",
      { value: "Ada Lovelace", update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);
  expect(
    runQuery(h.replica, covered.query),
    "the user_0 write must change the covered join",
  ).not.toEqual(coveredBefore);
  expect(covered.store.getSnapshot().data, "the covered join must follow the write").toEqual(
    runQuery(h.replica, covered.query),
  );
  // A many-cardinality join target, which is never covered.
  const many = h.watched.find((entry) => entry.name === "tags=label_0 + many join");
  if (many === undefined) throw new Error("no many-join query");
  const manyBefore = runQuery(h.replica, many.query);
  write("label_1 name (many join target)", [
    change(
      "label_1",
      "label/name",
      "replace",
      { value: "docs2", update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);
  expect(
    runQuery(h.replica, many.query),
    "the label_1 write must change the many join",
  ).not.toEqual(manyBefore);
  expect(many.store.getSnapshot().data, "the many join must follow the write").toEqual(
    runQuery(h.replica, many.query),
  );
  // A membership row refile: the entity row is untouched.
  write("membership row eg_3 -> g_1", [
    change(
      "eg_3",
      "ebb/membership",
      "replace",
      { value: { entity_id: "page_1", group_id: "g_1" }, update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);
  // A removed edge, whose old target the journal does not name.
  write("link page_0 -assignee-> user_0", [
    linkChange("page_0", "assignee", "page", "user_0", false, sequence),
  ]);
  // An existence transition.
  write("drop todo_0 due", [change("todo_0", "todo/due", "drop", null, sequence)]);
  // A source row of a self-relation (`parent` is page -> page): its own
  // projection is not covered by the join's target model.
  write("page_1 title (self-relation source)", [
    change(
      "page_1",
      "page/title",
      "replace",
      { value: "Beta2", update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);
  // A predicate/order component.
  write("page_2 title", [
    change(
      "page_2",
      "page/title",
      "replace",
      { value: "Gamma2", update_id: `u_${sequence}`, hlc },
      sequence,
    ),
  ]);
  return labels;
};

describe("dispatch conservatism: a retained result always matches a fresh run", () => {
  it("never misses a change its result observes", () => {
    for (const seed of [1, 2, 3]) {
      const h = harness();
      try {
        check(h, `seed ${seed} initial`);
        knownMisses(h, (label) => check(h, `seed ${seed} ${label}`));
        const random = mulberry32(seed);
        for (let index = 0; index < 60; index += 1) {
          const label = step(h, random);
          check(h, `seed ${seed} step ${index}: ${label}`);
        }
      } finally {
        h.close();
      }
    }
  });
});
