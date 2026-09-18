/**
 * Wire format adapter — convert between ebb Actions and tree DocActions.
 *
 * Ebb's wire protocol sees a run as just another entity: an Update with
 * `subject_type: "run"`, `subject_id: <runId>`, and
 * `method: put | patch | delete`. The field data carries the payload:
 *
 * - `put`   → `data.fields.run = { value: <RunNode>, update_id, hlc, splitParentAt? }`
 * - `patch` → `data.fields.append = { value: { text }, update_id, hlc }`
 * - `delete`→ `data.fields.range = { value: { offset, count }, update_id, hlc }`
 *
 * `splitParentAt` is informational metadata: when the sender's local edit
 * was mid-run, the receiver must perform the same split before applying
 * the INSERT_RUN. SPLIT itself is never broadcast — it's a local-only
 * consequence of receiving a remote insert (each peer does its own splits
 * as needed).
 *
 * ## Why `type` and `splitParentAt` aren't in core's FieldValue schema
 *
 * The core `FieldValueSchema` is `{ value, update_id, hlc }` — extra fields
 * are silently dropped by storage (its extractFields cast ignores anything
 * else). Storage stays dumb on purpose (per Decision 1 in the design doc).
 * We rely on the field name (`run` / `append` / `range`) as the type
 * discriminator instead of an inner `type` tag.
 *
 * ## Subject type
 *
 * All updates targeting a run carry `subject_type: "run"`. The receiving
 * peer filters by this marker; entities of other subject types are passed
 * through unchanged.
 *
 * ## Action-level dedup
 *
 * The storage adapter's ActionLog already enforces idempotency
 * (`storage.actions.append` is a no-op for repeated IDs). So `applyActions`
 * here does not track seen IDs separately — it relies on the caller having
 * routed actions through the storage layer first.
 */

import type { Action, HLCTimestamp, Update } from "@ebbjs/core";
import { docReducer, type DocAction, type DocState, type RunNode } from "./tree";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RUN_SUBJECT_TYPE = "run";

/** Well-known field names in the wire format. */
export const FIELD_RUN = "run";
export const FIELD_APPEND = "append";
export const FIELD_RANGE = "range";

// ---------------------------------------------------------------------------
// Field value shapes
//
// These mirror the core FieldValue shape ({ value, update_id, hlc }) plus
// optional metadata. Storage reads only { value, update_id, hlc } so the
// extras are ignored there.
// ---------------------------------------------------------------------------

/** `put` Update payload for a run. */
export type CausalTreeRunFieldValue = {
  readonly value: RunNode;
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
  /**
   * If set, the parent run was split at this offset on the sender before
   * this insert. The receiver must perform the same split before applying
   * the INSERT_RUN. The split is idempotent — repeated splits at the same
   * offset are no-ops.
   */
  readonly splitParentAt?: number;
};

/** `patch` Update payload: append text to an existing run. */
export type CausalTreeAppendFieldValue = {
  readonly value: { readonly text: string };
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
};

/** `delete` Update payload: tombstone a range of a run. */
export type CausalTreeRangeFieldValue = {
  readonly value: { readonly offset: number; readonly count: number };
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
};

// ---------------------------------------------------------------------------
// Update ↔ DocAction conversion
// ---------------------------------------------------------------------------

/**
 * Decide whether an Update targets a run. Use this to filter updates when
 * applying an Action to a document — non-run updates are ignored.
 */
export const isRunUpdate = (update: Update): boolean => update.subject_type === RUN_SUBJECT_TYPE;

/** Read a field value from `update.data`, ignoring TypeBox's strict schema. */
const readField = (update: Update, fieldName: string): Record<string, unknown> | null => {
  if (!update.data || typeof update.data !== "object") return null;
  const fields = update.data as Record<string, Record<string, unknown>>;
  const field = fields[fieldName];
  if (!field || typeof field !== "object") return null;
  return field;
};

/**
 * Convert a wire-format Update into a DocAction. Returns null if the Update
 * doesn't carry run data (e.g., it's targeting a different subject type, or
 * it's a malformed run Update).
 *
 * Note: SPLIT is NOT represented in wire format — splits are local-only.
 * The split hint lives inside the `put` payload's `splitParentAt` field.
 */
export const updateToDocAction = (update: Update): DocAction | null => {
  if (!isRunUpdate(update)) return null;

  if (update.method === "put") {
    const f = readField(update, FIELD_RUN) as CausalTreeRunFieldValue | null;
    if (!f || !f.value || !f.value.id) return null;
    return { type: "INSERT_RUN", node: f.value, splitParentAt: f.splitParentAt };
  }

  if (update.method === "patch") {
    const f = readField(update, FIELD_APPEND) as CausalTreeAppendFieldValue | null;
    if (!f || typeof f.value?.text !== "string") return null;
    return { type: "EXTEND_RUN", runId: update.subject_id, appendText: f.value.text };
  }

  if (update.method === "delete") {
    const f = readField(update, FIELD_RANGE) as CausalTreeRangeFieldValue | null;
    if (!f || typeof f.value?.offset !== "number" || typeof f.value?.count !== "number")
      return null;
    return {
      type: "DELETE_RANGE",
      runId: update.subject_id,
      offset: f.value.offset,
      count: f.value.count,
    };
  }

  return null;
};

/**
 * Convert a DocAction into a wire-format Update. Returns null for SPLIT
 * (local-only — never broadcast).
 *
 * The actor and HLC come from the originating Action, not from the node
 * itself. Pass them via `opts`.
 */
export const docActionToUpdate = (
  action: DocAction,
  opts: { actorId: string; hlc: HLCTimestamp; updateId: string },
): Update | null => {
  switch (action.type) {
    case "INSERT_RUN": {
      const field: CausalTreeRunFieldValue = {
        value: action.node,
        update_id: opts.updateId,
        hlc: opts.hlc,
        ...(action.splitParentAt !== undefined && { splitParentAt: action.splitParentAt }),
      };
      return {
        id: opts.updateId,
        subject_id: action.node.id,
        subject_type: RUN_SUBJECT_TYPE,
        method: "put",
        data: { [FIELD_RUN]: field as unknown as never },
      };
    }
    case "EXTEND_RUN": {
      const field: CausalTreeAppendFieldValue = {
        value: { text: action.appendText },
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
      return {
        id: opts.updateId,
        subject_id: action.runId,
        subject_type: RUN_SUBJECT_TYPE,
        method: "patch",
        data: { [FIELD_APPEND]: field as unknown as never },
      };
    }
    case "DELETE_RANGE": {
      const field: CausalTreeRangeFieldValue = {
        value: { offset: action.offset, count: action.count },
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
      return {
        id: opts.updateId,
        subject_id: action.runId,
        subject_type: RUN_SUBJECT_TYPE,
        method: "delete",
        data: { [FIELD_RANGE]: field as unknown as never },
      };
    }
    case "SPLIT":
      // Local-only — splits are inferred from splitParentAt on a put.
      return null;
  }
};

// ---------------------------------------------------------------------------
// Apply wire Actions to a DocState
// ---------------------------------------------------------------------------

/**
 * Apply a list of wire-format Actions to a DocState, producing the new
 * state plus a list of the resulting DocActions that were applied.
 *
 * The caller is responsible for:
 * - Routing Actions through the storage adapter first (so dedup happens)
 * - Filtering Actions by group/entity scope before calling
 *
 * Side effects of a single run Update:
 * - A `put` with `splitParentAt` triggers a SPLIT before the INSERT_RUN.
 * - All other Updates translate 1:1 to a DocAction.
 */
export const applyActions = (
  state: DocState,
  actions: readonly Action[],
): { state: DocState; applied: DocAction[] } => {
  let current = state;
  const applied: DocAction[] = [];

  for (const action of actions) {
    for (const update of action.updates) {
      if (!isRunUpdate(update)) continue;

      const docAction = updateToDocAction(update);
      if (!docAction) continue;

      if (docAction.type === "INSERT_RUN" && docAction.splitParentAt !== undefined) {
        const parentNode = current.nodes.get(docAction.node.parentId);
        if (parentNode && parentNode.text.length > docAction.splitParentAt) {
          const splitAction: DocAction = {
            type: "SPLIT",
            runId: docAction.node.parentId,
            offset: docAction.splitParentAt,
          };
          current = docReducer(current, splitAction);
          applied.push(splitAction);
        }
      }

      current = docReducer(current, docAction);
      // Strip wire-format metadata (splitParentAt) before recording — the
      // applied list is consumed for tree mutations only, and splitParentAt
      // is wire-format metadata that the tree doesn't track.
      if (docAction.type === "INSERT_RUN") {
        const { splitParentAt: _split, ...actionWithoutSplit } = docAction;
        applied.push(actionWithoutSplit);
      } else {
        applied.push(docAction);
      }
    }
  }

  return { state: current, applied };
};

/**
 * Validate that an Update's data shape matches what the tree expects for
 * its method. Used by callers to detect malformed updates before applying.
 */
export const isWellFormedRunUpdate = (update: Update): boolean => {
  if (!isRunUpdate(update)) return false;
  if (!update.data || typeof update.data !== "object") return false;
  if (update.method === "put") return readField(update, FIELD_RUN) !== null;
  if (update.method === "patch") return readField(update, FIELD_APPEND) !== null;
  if (update.method === "delete") return readField(update, FIELD_RANGE) !== null;
  return false;
};
