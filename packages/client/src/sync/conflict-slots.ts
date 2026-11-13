/**
 * Conflict slots — the generic recursion that turns a local write and a
 * missed inbound write into the positions they contest.
 *
 * The position vocabulary is the merge vocabulary: map keys inside a
 * component merge key by key, so two writes to different keys are different
 * positions and do not conflict, while a leaf or a kind change is one
 * position. For a collaborative-text document this recursion *is* the
 * conflict policy — concurrent inserts write different run keys and never
 * surface, while a concurrent extend-vs-delete on one run is one slot and
 * does.
 *
 * Detection (#390) uses this to find overlapping positions; resolution
 * (#392) reads the persisted slots back. The module is pure: it folds
 * Actions and reports sides, and reads the LWW component oracle through an
 * injected predicate.
 */

import {
  componentModel,
  isFieldMap,
  mergeFieldValue,
  type Action,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { ConflictScope } from "@ebbjs/schema";
import type { ConflictHold, ConflictSide, ConflictSlot } from "@ebbjs/storage/types";

import { projectFieldValue } from "./query-builder";

/** Granularity ordering for a conflict: `field` < `component` < `entity`. */
const SCOPE_RANK: Readonly<Record<ConflictScope, number>> = {
  field: 1,
  component: 2,
  entity: 3,
};

/** The coarsest scope wins: an entity-scope loss holds the whole conflict. */
export const coarsestScope = (scopes: readonly ConflictScope[]): ConflictScope =>
  scopes.reduce<ConflictScope>(
    (coarsest, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[coarsest] ? scope : coarsest),
    "field",
  );

/** The component-kind oracle the outbox injects; `undefined` defaults to LWW. */
export type LwwFieldOracle = ((model: string, component: string) => boolean) | undefined;

/** The effective inbound state for one subject an Action writes. */
export interface InboundSubject {
  /** The model the row is committed under. */
  readonly model: string;
  /**
   * A `delete` makes the Action's components the subject's whole component
   * set: a buffered write to a component the Action omits is reverted, not
   * left alone.
   */
  readonly deleted: boolean;
  /** The components the Action leaves attached, keyed by `<model>/<field>`. */
  readonly components: ReadonlyMap<string, FieldValue>;
}

/** The components a buffered Action writes to one subject. */
export interface PendingWrite {
  readonly model: string;
  readonly components: ReadonlyMap<string, FieldValue>;
}

const isDeleteUpdate = (update: Update): update is Extract<Update, { method: "delete" }> =>
  update.method === "delete";

/** Fold one component Update into a per-subject component map. */
const mergeUpdateComponents = (components: Map<string, FieldValue>, update: Update): void => {
  if (isDeleteUpdate(update)) return;
  if (update.method === "drop") {
    components.delete(update.component);
    return;
  }
  const previous = components.get(update.component);
  components.set(
    update.component,
    previous === undefined ? update.data : mergeFieldValue(previous, update.data),
  );
};

/** Fold one Action's Updates into an existing per-subject accumulator. */
const foldAction = (subjects: Map<string, InboundSubject>, action: Action): void => {
  for (const update of action.updates) {
    const current = subjects.get(update.subject_id) ?? {
      model: isDeleteUpdate(update) ? "" : componentModel(update.component),
      deleted: false,
      components: new Map<string, FieldValue>(),
    };
    if (isDeleteUpdate(update)) {
      subjects.set(update.subject_id, { ...current, deleted: true, components: new Map() });
      continue;
    }
    const components = new Map(current.components);
    mergeUpdateComponents(components, update);
    subjects.set(update.subject_id, {
      model: componentModel(update.component),
      deleted: current.deleted,
      components,
    });
  }
};

/**
 * Collapse one Action's Updates into one effective state per subject,
 * applied in order. A `delete` clears the subject's component set; a `drop`
 * detaches one component; a `merge` / `replace` merges its component value
 * into whatever stands.
 */
export const inboundSubjects = (action: Action): Map<string, InboundSubject> => {
  const subjects = new Map<string, InboundSubject>();
  foldAction(subjects, action);
  return subjects;
};

/**
 * Collapse a whole missed window into one effective state per subject,
 * folded in the order the Actions are supplied (catch-up pages arrive in
 * GSN order). This is the value the server holds once the window lands,
 * and so the `remote` side of every slot.
 */
export const foldInboundWindow = (actions: readonly Action[]): Map<string, InboundSubject> => {
  const subjects = new Map<string, InboundSubject>();
  for (const action of actions) foldAction(subjects, action);
  return subjects;
};

export const actionWrites = (action: Action): Map<string, PendingWrite> => {
  const writes = new Map<string, PendingWrite>();
  for (const update of action.updates) {
    const current = writes.get(update.subject_id);
    const components = new Map(current?.components ?? []);
    mergeUpdateComponents(components, update);
    writes.set(update.subject_id, {
      model: current?.model ?? (isDeleteUpdate(update) ? "" : componentModel(update.component)),
      components,
    });
  }
  return writes;
};

/** Stable key for one held position: the subject, and `*` for the whole subject. */
export const holdKey = (hold: Pick<ConflictHold, "subjectId" | "component">): string =>
  `${hold.subjectId}\u0000${hold.component ?? "*"}`;

/**
 * The holds a conflict payload carries. A row written before the component
 * hold names only subjects, and holds each of them whole — the behavior it
 * was detected under.
 */
export const conflictHolds = (conflict: {
  readonly subjects: readonly string[];
  readonly holds?: readonly ConflictHold[];
}): readonly ConflictHold[] =>
  conflict.holds ?? conflict.subjects.map((subjectId) => ({ subjectId }));

/**
 * Whether an Action writes any held position. An Action cannot be submitted
 * in part, so touching one held component holds the whole Action; a
 * `delete` Update detaches every component of its subject.
 */
export const actionTouchesHolds = (action: Action, holds: readonly ConflictHold[]): boolean => {
  if (holds.length === 0) return false;
  for (const update of action.updates) {
    for (const hold of holds) {
      if (hold.subjectId !== update.subject_id) continue;
      if (hold.component === undefined) return true;
      if (update.method === "delete" || update.component === hold.component) return true;
    }
  }
  return false;
};

/**
 * The `ConflictSide` view of a FieldValue: a leaf carries its LWW triple,
 * a whole-component map has no single leaf and `value` is the projected map.
 * A leaf tombstone (`value: null`) is absence, so its side value is
 * `undefined` — the read model has no stored null.
 */
export const conflictSide = (value: FieldValue): ConflictSide => {
  if (isFieldMap(value)) return { value: projectFieldValue(value) };
  const side: { value: unknown; update_id?: string; hlc?: string } = {
    value: value.value ?? undefined,
  };
  if (value.update_id !== undefined) side.update_id = value.update_id;
  if (value.hlc !== undefined) side.hlc = value.hlc;
  return side;
};

export const nodeAtPath = (value: FieldValue, path: readonly string[]): FieldValue | undefined => {
  let node: FieldValue | undefined = value;
  for (const key of path) {
    if (node === undefined || !isFieldMap(node)) return undefined;
    node = node.map[key];
  }
  return node;
};

/**
 * The map-key paths where both values hold something: a shared leaf, or
 * the path where their kinds diverge. Sibling map keys are distinct
 * positions and are not reported. Values alone do not decide a conflict —
 * detection triggers on concurrency, so a shared path is reported even
 * when the local value would win the merge.
 */
export const overlappingPaths = (
  pending: FieldValue,
  inbound: FieldValue,
  path: readonly string[] = [],
): string[][] => {
  if (isFieldMap(pending) && isFieldMap(inbound)) {
    const paths: string[][] = [];
    for (const [key, inboundChild] of Object.entries(inbound.map)) {
      const pendingChild = pending.map[key];
      if (pendingChild === undefined) continue;
      paths.push(...overlappingPaths(pendingChild, inboundChild, [...path, key]));
    }
    return paths;
  }
  return [[...path]];
};

/** Stable key for one position, so detection can dedupe overlapping reports. */
export const slotKey = (slot: Pick<ConflictSlot, "subjectId" | "component" | "path">): string =>
  `${slot.subjectId}\u0000${slot.component}\u0000${slot.path.join("\u0001")}`;

/**
 * A contested slot with its local side and the `remote` value the server
 * holds after the missed window. A path the fold never wrote (or an inbound
 * `delete` reverted) has a `{ value: undefined }` remote.
 */
export const conflictSlot = (args: {
  subjectId: string;
  component: string;
  path: readonly string[];
  pending: FieldValue;
  remote: FieldValue | undefined;
}): ConflictSlot => {
  const local = nodeAtPath(args.pending, args.path);
  const remote = args.remote === undefined ? undefined : nodeAtPath(args.remote, args.path);
  return {
    subjectId: args.subjectId,
    component: args.component,
    path: args.path,
    local: local === undefined ? { value: undefined } : conflictSide(local),
    remote: remote === undefined ? { value: undefined } : conflictSide(remote),
  };
};
