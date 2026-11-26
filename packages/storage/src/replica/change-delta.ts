import { linkEdges, systemValueString, type Entity, type LinkEdge } from "@ebbjs/core";

import { componentSetDelta } from "../internal/component-index";

import { sourceRow } from "./row-index";
import type { ChangeDelta, MembershipSide } from "./types";

/** One row's state on one side of a change: the row and the components it carries. */
export interface ChangeSides {
  readonly row: Entity | null;
  readonly components: readonly string[];
}

type EdgePart = NonNullable<ChangeDelta["edges"]>[number];

interface EdgeGroup {
  readonly as: string;
  readonly type: string;
  readonly targets: string[];
}

/** A row's live edges; a tombstoned row contributes none, matching `entryOf`. */
const liveEdges = (row: Entity | null): readonly LinkEdge[] =>
  row === null || row.deleted_hlc !== null ? [] : linkEdges(row);

const NUL = "\u0000";

const edgeKey = (as: string, type: string): string => `${as}${NUL}${type}`;

/**
 * A row's edges grouped by `(as, type)`. `linkEdges` answers ascending, so every
 * group's targets are already sorted and unique.
 */
const groupEdges = (row: Entity | null): ReadonlyMap<string, EdgeGroup> => {
  const groups = new Map<string, EdgeGroup>();
  for (const edge of liveEdges(row)) {
    const key = edgeKey(edge.as, edge.type);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { as: edge.as, type: edge.type, targets: [edge.targetId] });
    } else group.targets.push(edge.targetId);
  }
  return groups;
};

/** Every `(as, type)` whose targets moved, ascending by `as` then `type`. */
const edgeDelta = (before: Entity | null, after: Entity | null): ChangeDelta["edges"] => {
  const previous = groupEdges(before);
  const next = groupEdges(after);
  const parts: EdgePart[] = [];
  for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const beforeGroup = previous.get(key);
    const afterGroup = next.get(key);
    const beforeTargets = new Set(beforeGroup?.targets ?? []);
    const afterTargets = new Set(afterGroup?.targets ?? []);
    const added = (afterGroup?.targets ?? []).filter((target) => !beforeTargets.has(target));
    const removed = (beforeGroup?.targets ?? []).filter((target) => !afterTargets.has(target));
    if (added.length === 0 && removed.length === 0) continue;
    const group = afterGroup ?? beforeGroup;
    if (group === undefined) continue;
    parts.push({ as: group.as, type: group.type, added, removed });
  }
  return parts.length === 0 ? undefined : parts;
};

/** Components one side carries and the other does not, which is existence moving. */
const existenceDelta = (
  id: string,
  before: readonly string[],
  after: readonly string[],
): ChangeDelta["existence"] => {
  const delta = componentSetDelta(id, before, after);
  return delta === null ? undefined : { added: delta.add, removed: delta.remove };
};

/**
 * The membership pair a row states, or none when it states no pair. The value
 * carries both halves at once, so a side missing either half files no
 * membership: the member a row-subscription resolver keys on and the group a
 * scoped resolver keys on are both unknown then, and a reader falls back
 * instead of to a key nothing declares.
 */
const membershipOf = (row: Entity | null): MembershipSide | null => {
  const filed = sourceRow(row);
  if (filed === null) return null;
  const entityId = systemValueString(filed, "membership", "entity_id");
  const groupId = systemValueString(filed, "membership", "group_id");
  if (entityId === null || entityId.length === 0) return null;
  if (groupId === null || groupId.length === 0) return null;
  return { entityId, groupId };
};

/** The pairs a change moved a row between: a move names both, leaving names one. */
const membershipDelta = (
  before: Entity | null,
  after: Entity | null,
): ChangeDelta["membership"] => {
  const previous = membershipOf(before);
  const next = membershipOf(after);
  if (previous?.entityId === next?.entityId && previous?.groupId === next?.groupId) {
    return undefined;
  }
  return { before: previous, after: next };
};

/**
 * What a change moved in the index: the edges, component existence and the
 * membership pair on both sides. Only a write that still holds the old state
 * can answer this, which is why the journal records it rather than a reader
 * deriving it from the row. `undefined` when nothing moved.
 */
export const changeDeltaOf = (
  id: string,
  before: ChangeSides,
  after: ChangeSides,
): ChangeDelta | undefined => {
  const edges = edgeDelta(before.row, after.row);
  const existence = existenceDelta(id, before.components, after.components);
  const membership = membershipDelta(before.row, after.row);
  if (edges === undefined && existence === undefined && membership === undefined) {
    return undefined;
  }
  const delta: {
    edges?: ChangeDelta["edges"];
    existence?: ChangeDelta["existence"];
    membership?: ChangeDelta["membership"];
  } = {};
  if (edges !== undefined) delta.edges = edges;
  if (existence !== undefined) delta.existence = existence;
  if (membership !== undefined) delta.membership = membership;
  return delta;
};
