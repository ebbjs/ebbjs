import {
  fieldComponent,
  isFieldMap,
  linkEdges,
  systemValueString,
  type Entity,
  type FieldValue,
  type LinkEdge,
} from "@ebbjs/core";

import { jsonBytes } from "./size";

/**
 * One row's place in every lookup a query decides on. `fields` is the
 * always-resident set: leaves and `ebb/*` values. A map-shaped user component
 * is named in `components` but its value lives in the value cache.
 */
export interface RowEntry {
  readonly id: string;
  /** The committed model; `""` while a placeholder has no model. */
  readonly model: string;
  /** Whether the row's create has been seen. */
  readonly exists: boolean;
  /** Whether the row is tombstoned. */
  readonly deleted: boolean;
  /** The tombstone's timestamp, or `null` while the row is live. */
  readonly deletedHlc: string | null;
  readonly createdHlc: string | null;
  readonly updatedHlc: string;
  readonly lastGsn: number;
  /** Components (`<model>/<field>`) the row carries, in field order. */
  readonly components: readonly string[];
  /** The declared version each carried component was materialized at. */
  readonly versions: Readonly<Record<string, number>>;
  /** Live `ebb/link` edges; empty for a tombstoned row. */
  readonly edges: readonly LinkEdge[];
  /** The live `ebb/membership` pair; `null` for a tombstoned row or no membership. */
  readonly membership: { readonly groupId: string; readonly entityId: string } | null;
  /** The always-resident values: leaves and `ebb/*` components. */
  readonly fields: Readonly<Record<string, FieldValue>>;
}

const isAlwaysResident = (component: string, value: FieldValue): boolean =>
  component.startsWith("ebb/") || !isFieldMap(value);

/** The only place that decides which values stay in the index. */
export const entryOf = (row: Entity, versions: Readonly<Record<string, number>> = {}): RowEntry => {
  const components: string[] = [];
  const fields: Record<string, FieldValue> = {};
  const stamped: Record<string, number> = {};
  for (const [field, value] of Object.entries(row.data.fields)) {
    const component = fieldComponent(row.model, field);
    components.push(component);
    stamped[component] = versions[component] ?? 1;
    if (isAlwaysResident(component, value)) fields[field] = value;
  }

  const deleted = row.deleted_hlc !== null;
  const groupId = deleted ? null : systemValueString(row, "membership", "group_id");
  const entityId = deleted ? null : systemValueString(row, "membership", "entity_id");

  return {
    id: row.id,
    model: row.model,
    exists: row.exists,
    deleted,
    deletedHlc: row.deleted_hlc,
    createdHlc: row.created_hlc,
    updatedHlc: row.updated_hlc,
    lastGsn: row.last_gsn,
    components,
    versions: stamped,
    edges: deleted ? [] : linkEdges(row),
    membership: groupId === null || entityId === null ? null : { groupId, entityId },
    fields,
  };
};

/** One live membership row: the pair it files and the row that files it. */
export interface MembershipRow {
  readonly membershipId: string;
  readonly groupId: string;
  readonly entityId: string;
}

/**
 * The in-memory lookups a query reads. Every read is deterministic and
 * ascending, and every lookup answers from entries rather than from values.
 */
export interface RowIndex {
  get(id: string): RowEntry | undefined;
  /** Every entry, ascending by id. */
  entries(): readonly RowEntry[];
  idsOfModel(model: string): readonly string[];
  idsWithComponent(component: string): readonly string[];
  /** Distinct live sources of the edges under `(as, type, targetId)`, ascending. */
  edgeSources(as: string, type: string, targetId: string): readonly string[];
  /** Distinct live targets of the source row's edges under `(as, type)`, ascending. */
  edgeTargets(as: string, type: string, sourceId: string): readonly string[];
  /** Distinct live member ids of a group, ascending. */
  groupMembers(groupId: string): readonly string[];
  /** Distinct live group ids of an entity, ascending. */
  entityGroups(entityId: string): readonly string[];
  /**
   * Live membership rows, ascending by group then row id; `entityId` narrows
   * the answer to one entity's.
   */
  membershipRows(entityId?: string): readonly MembershipRow[];
  /** Diff `entry` against its previous version and update every lookup. */
  set(entry: RowEntry): void;
  remove(id: string): void;
  clear(): void;
  /** Serialized bytes of the derived maps, for diagnostics. */
  bytes(): number;
}

const NUL = "\u0000";

const edgeKey = (as: string, type: string, targetId: string): string =>
  `${as}${NUL}${type}${NUL}${targetId}`;

const ascending = (values: Iterable<string>): string[] => [...values].sort();

const byGroupThenRow = (a: MembershipRow, b: MembershipRow): number =>
  a.groupId === b.groupId
    ? a.membershipId.localeCompare(b.membershipId)
    : a.groupId.localeCompare(b.groupId);

/** The entry-keyed maps one direction owns, mutated in place. */
type Rows = Map<string, Map<string, string>>;

const addRow = (rows: Rows, key: string, id: string, value: string): void => {
  const under = rows.get(key);
  if (under === undefined) rows.set(key, new Map([[id, value]]));
  else under.set(id, value);
};

const removeRow = (rows: Rows, key: string, id: string): void => {
  const under = rows.get(key);
  if (under === undefined) return;
  under.delete(id);
  if (under.size === 0) rows.delete(key);
};

const distinctValues = (rows: Map<string, string> | undefined): string[] =>
  ascending(new Set(rows?.values() ?? []));

const addTo = (sets: Map<string, Set<string>>, key: string, id: string): void => {
  const ids = sets.get(key);
  if (ids === undefined) sets.set(key, new Set([id]));
  else ids.add(id);
};

const removeFrom = (sets: Map<string, Set<string>>, key: string, id: string): void => {
  const ids = sets.get(key);
  if (ids === undefined) return;
  ids.delete(id);
  if (ids.size === 0) sets.delete(key);
};

/**
 * Build an empty index. A mutable object behind an immutable-by-convention
 * interface, the same shape the replica's other tables use.
 */
export const createRowIndex = (): RowIndex => {
  const entries = new Map<string, RowEntry>();
  const byModel = new Map<string, Set<string>>();
  const byComponent = new Map<string, Set<string>>();
  /** `(as, type, target)` → source row id → source row id. */
  const sources: Rows = new Map();
  /** group id → membership row id → member entity id. */
  const groups: Rows = new Map();
  /** member entity id → membership row id → group id. */
  const entityGroups: Rows = new Map();

  const contribute = (entry: RowEntry): void => {
    addTo(byModel, entry.model, entry.id);
    for (const component of entry.components) addTo(byComponent, component, entry.id);
    if (entry.deleted) return;
    for (const edge of entry.edges) {
      addRow(sources, edgeKey(edge.as, edge.type, edge.targetId), entry.id, entry.id);
    }
    if (entry.membership !== null) {
      addRow(groups, entry.membership.groupId, entry.id, entry.membership.entityId);
      addRow(entityGroups, entry.membership.entityId, entry.id, entry.membership.groupId);
    }
  };

  const withdraw = (entry: RowEntry): void => {
    removeFrom(byModel, entry.model, entry.id);
    for (const component of entry.components) removeFrom(byComponent, component, entry.id);
    for (const edge of entry.edges) {
      removeRow(sources, edgeKey(edge.as, edge.type, edge.targetId), entry.id);
    }
    if (entry.membership !== null) {
      removeRow(groups, entry.membership.groupId, entry.id);
      removeRow(entityGroups, entry.membership.entityId, entry.id);
    }
  };

  return {
    get: (id) => entries.get(id),
    entries: () => ascending(entries.keys()).map((id) => entries.get(id) as RowEntry),
    idsOfModel: (model) => ascending(byModel.get(model) ?? []),
    idsWithComponent: (component) => ascending(byComponent.get(component) ?? []),
    edgeSources: (as, type, targetId) => distinctValues(sources.get(edgeKey(as, type, targetId))),
    edgeTargets: (as, type, sourceId) => {
      const entry = entries.get(sourceId);
      if (entry === undefined) return [];
      const targets = entry.edges
        .filter((edge) => edge.as === as && edge.type === type)
        .map((edge) => edge.targetId);
      return ascending(new Set(targets));
    },
    groupMembers: (groupId) => distinctValues(groups.get(groupId)),
    entityGroups: (entityId) => distinctValues(entityGroups.get(entityId)),
    membershipRows: (entityId) => {
      if (entityId !== undefined) {
        return [...(entityGroups.get(entityId) ?? new Map())]
          .map(([membershipId, groupId]) => ({ membershipId, groupId, entityId }))
          .sort(byGroupThenRow);
      }
      const rows: MembershipRow[] = [];
      for (const [groupId, members] of groups) {
        for (const [membershipId, memberId] of members) {
          rows.push({ membershipId, groupId, entityId: memberId });
        }
      }
      return rows.sort(byGroupThenRow);
    },
    set: (entry) => {
      const previous = entries.get(entry.id);
      if (previous !== undefined) withdraw(previous);
      entries.set(entry.id, entry);
      contribute(entry);
    },
    remove: (id) => {
      const previous = entries.get(id);
      if (previous === undefined) return;
      withdraw(previous);
      entries.delete(id);
    },
    clear: () => {
      entries.clear();
      byModel.clear();
      byComponent.clear();
      sources.clear();
      groups.clear();
      entityGroups.clear();
    },
    bytes: () => {
      const sizeOf = (rows: Map<string, unknown>): number => {
        if (rows.size === 0) return 0;
        return jsonBytes(Object.fromEntries(rows));
      };
      const idsOf = (sets: Map<string, Set<string>>): Map<string, string[]> =>
        new Map([...sets].map(([key, ids]) => [key, ascending(ids)]));
      const rowsOf = (rows: Rows): Map<string, Record<string, string>> =>
        new Map([...rows].map(([key, under]) => [key, Object.fromEntries(under)]));
      return (
        sizeOf(idsOf(byModel)) +
        sizeOf(idsOf(byComponent)) +
        sizeOf(rowsOf(sources)) +
        sizeOf(rowsOf(groups)) +
        sizeOf(rowsOf(entityGroups))
      );
    },
  };
};
