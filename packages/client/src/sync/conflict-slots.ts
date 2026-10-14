/**
 * Conflict slots — the generic recursion that turns a local write and a
 * missed inbound write into the positions they contest.
 *
 * The position vocabulary is the merge vocabulary: map keys merge key by
 * key, so two writes to different keys are different positions and do
 * not conflict, while a leaf or a kind change is one position. For a
 * collaborative-text document this recursion *is* the conflict policy —
 * concurrent inserts write different run keys and never surface, while a
 * concurrent extend-vs-delete on one run is one slot and does.
 *
 * Detection (#390) uses this to find overlapping positions; resolution
 * (#392) reads the persisted slots back. The module is pure: it folds
 * Actions and reports sides, and reads the LWW field oracle through an
 * injected predicate.
 */

import {
  isFieldMap,
  mergeFieldValue,
  type Action,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import type { ConflictSide, ConflictSlot } from "@ebbjs/storage/types";

import { projectFieldValue } from "./query-builder";

/**
 * Subject types whose Updates carry structural edges, not LWW field
 * writes: a `relationship` edge, an `entityGroup` membership, and a
 * `groupMember` permission row. Concurrent writes to edges are never
 * surfaced as conflicts.
 */
export const STRUCTURAL_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "relationship",
  "entityGroup",
  "groupMember",
]);

/** The field-kind oracle the outbox injects; `undefined` defaults to LWW. */
export type LwwFieldOracle = ((subjectType: string, field: string) => boolean) | undefined;

/** The effective inbound state for one subject an Action writes. */
export interface InboundSubject {
  readonly subjectType: string;
  /**
   * A `put` or `delete` makes the Action's fields the subject's whole
   * field set: a buffered write to a field the Action omits is reverted,
   * not left alone.
   */
  readonly replaced: boolean;
  readonly fields: ReadonlyMap<string, FieldValue>;
}

/** The fields a buffered Action writes to one subject. */
export interface PendingWrite {
  readonly subjectType: string;
  readonly fields: ReadonlyMap<string, FieldValue>;
}

/** The field map an Update carries, tolerating a peer's unwrapped envelope. */
const updateFields = (update: Update): Record<string, FieldValue> | undefined =>
  update.data?.fields as Record<string, FieldValue> | undefined;

const mergeUpdateFields = (fields: Map<string, FieldValue>, update: Update): void => {
  for (const [field, value] of Object.entries(updateFields(update) ?? {})) {
    const previous = fields.get(field);
    fields.set(field, previous === undefined ? value : mergeFieldValue(previous, value));
  }
};

/** Fold one Action's Updates into an existing per-subject accumulator. */
const foldAction = (subjects: Map<string, InboundSubject>, action: Action): void => {
  for (const update of action.updates) {
    const current = subjects.get(update.subject_id) ?? {
      subjectType: update.subject_type,
      replaced: false,
      fields: new Map<string, FieldValue>(),
    };
    if (update.method === "put") {
      const fields = new Map<string, FieldValue>();
      mergeUpdateFields(fields, update);
      subjects.set(update.subject_id, { ...current, replaced: true, fields });
      continue;
    }
    if (update.method === "delete") {
      subjects.set(update.subject_id, { ...current, replaced: true, fields: new Map() });
      continue;
    }
    const fields = new Map(current.fields);
    mergeUpdateFields(fields, update);
    subjects.set(update.subject_id, { ...current, fields });
  }
};

/**
 * Collapse one Action's Updates into one effective state per subject,
 * applied in order. A `put` replaces the subject's whole field set (a
 * missing `fields` map replaces it with nothing); a `delete` leaves it
 * empty; a `patch` merges its fields into whatever stands.
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
    const fields = new Map(current?.fields ?? []);
    mergeUpdateFields(fields, update);
    writes.set(update.subject_id, { subjectType: update.subject_type, fields });
  }
  return writes;
};

export const actionTouchesSubject = (action: Action, subjectId: string): boolean =>
  action.updates.some((update) => update.subject_id === subjectId);

/** True when an inbound write to `field` can silently overwrite a local one. */
export const isConflictableField = (
  isLwwField: LwwFieldOracle,
  subjectType: string,
  field: string,
): boolean =>
  !STRUCTURAL_SUBJECT_TYPES.has(subjectType) && (isLwwField?.(subjectType, field) ?? true);

/**
 * The `ConflictSide` view of a FieldValue: a leaf carries its LWW triple,
 * a whole-field map has no single leaf and `value` is the projected map.
 */
export const conflictSide = (value: FieldValue): ConflictSide => {
  if (isFieldMap(value)) return { value: projectFieldValue(value) };
  const side: { value: unknown; update_id?: string; hlc?: string } = { value: value.value };
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

/**
 * A contested slot with its local side and the `remote` value the server
 * holds after the missed window. A path the fold never wrote (or an
 * inbound `put` / `delete` reverted) has a `{ value: undefined }` remote.
 */
/** Stable key for one position, so detection can dedupe overlapping reports. */
export const slotKey = (slot: Pick<ConflictSlot, "subjectId" | "field" | "path">): string =>
  `${slot.subjectId}\u0000${slot.field}\u0000${slot.path.join("\u0001")}`;

export const conflictSlot = (args: {
  subjectId: string;
  field: string;
  path: readonly string[];
  pending: FieldValue;
  remote: FieldValue | undefined;
}): ConflictSlot => {
  const local = nodeAtPath(args.pending, args.path);
  const remote = args.remote === undefined ? undefined : nodeAtPath(args.remote, args.path);
  return {
    subjectId: args.subjectId,
    field: args.field,
    path: args.path,
    local: local === undefined ? { value: undefined } : conflictSide(local),
    remote: remote === undefined ? { value: undefined } : conflictSide(remote),
  };
};
