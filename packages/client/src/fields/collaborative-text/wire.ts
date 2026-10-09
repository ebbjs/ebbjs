/**
 * Wire format adapter — convert between ebb Actions and tree DocActions.
 *
 * ## Design: the document is an entity; runs are keys of its map field
 *
 * A collaborative-text document is an ebb entity of type `text_document`
 * (configurable). Its runs live in a single declared map field,
 * `content`, whose keys are run ids and whose values are the run nodes.
 * This keeps the doc as the only entity the server ever sees — runs never
 * appear as separate entities, so the server's permission model
 * (`<type>.<verb>` scoped per group) gates the whole document with a
 * single grant: `text_document.update` (or `text_document.*`) covers all
 * run operations.
 *
 * The field is a *map* field (#326), so the merge is per key: two peers
 * inserting at different positions write different keys and never
 * conflict, while a concurrent extend-vs-delete on one run is a single
 * key and resolves (and can be surfaced) as one slot.
 *
 * Wire-format shape for a run update:
 *
 * ```json
 * {
 *   "subject_id": "<docId>",
 *   "subject_type": "text_document",
 *   "method": "patch",
 *   "data": {
 *     "fields": {
 *       "content": {
 *         "map": {
 *           "<runId>": { "value": <RunNode | null>, "update_id": "<update-id>", "hlc": "<hlc>" }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * - `method: "patch"` always — storage's recursive map merge handles each
 *   run key independently.
 * - `value: null` is the tombstone encoding. The receiver drops the run
 *   from its tree.
 * - SPLITs are local-only consequences — the wire carries the resulting
 *   key updates (split halves + any tombstones) as a flat map. The
 *   receiver doesn't re-derive the splits.
 *
 * ## Why this is the right model
 *
 * The alternative — runs as separate entities with `subject_type: "run"`
 * — grants `run.update` permission too broadly: any actor with that
 * permission in a group can rewrite any run, including runs authored by
 * others. Doc-as-entity fixes this: the doc's `text_document.update`
 * permission gates all runs, and authorship is preserved by the run's
 * `actorId` field which the receiver keeps intact.
 *
 * @see packages/client/docs/prototypes/collaborative-text/README.md (Decision 1 + wire format)
 */

import {
  isFieldLeaf,
  isFieldMap,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";
import { DOC_CONTENT_FIELD } from "./schema";
import {
  applyRunFieldUpdates,
  makeRunId,
  ROOT_ID,
  type DocAction,
  type DocState,
  type RunFieldValue,
  type RunNode,
} from "./tree";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default document subject type for collaborative-text documents. */
export const DEFAULT_DOC_SUBJECT_TYPE = "text_document";

// ---------------------------------------------------------------------------
// Field value shapes (wire / client view)
// ---------------------------------------------------------------------------

/** Live run field on the document. */
export type CausalTreeRunFieldValue = {
  readonly value: RunNode;
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
};

/** Tombstoned run field on the document (kept for audit / late-apply). */
export type CausalTreeTombstoneFieldValue = {
  readonly value: null;
  readonly update_id: string;
  readonly hlc: HLCTimestamp;
};

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an Update targets the given document subject type. Use
 * this to filter updates from an Action before applying them to a
 * TextDocument (so non-doc updates pass through unchanged).
 */
export const isDocSubjectUpdate = (update: Update, docSubjectType: string): boolean =>
  update.subject_type === docSubjectType;

// ---------------------------------------------------------------------------
// Read side: parse incoming wire updates into field-update operations
// ---------------------------------------------------------------------------

/**
 * Read a document's `content` map into run-id → field-value entries.
 * Silently ignores non-map `content` values and non-leaf entries. The
 * map is the only run surface, so there is no field-name parsing.
 */
export const parseContentField = (
  content: FieldValue | undefined,
): ReadonlyMap<string, RunFieldValue> => {
  const out = new Map<string, RunFieldValue>();
  if (content === undefined || !isFieldMap(content)) return out;
  for (const [runId, entry] of Object.entries(content.map)) {
    if (!isFieldLeaf(entry)) continue;
    const update_id = typeof entry.update_id === "string" ? entry.update_id : "";
    const hlc = typeof entry.hlc === "string" ? entry.hlc : ("0" as HLCTimestamp);
    if (entry.value === null) {
      out.set(runId, { value: null, update_id, hlc });
    } else if (entry.value !== null && typeof entry.value === "object" && "id" in entry.value) {
      out.set(runId, { value: entry.value as RunNode, update_id, hlc });
    }
  }
  return out;
};

/**
 * Read the runs out of an Update that targets the document's `content`
 * map. Exported so the conflict path and the wire adapter unwrap the
 * envelope consistently.
 */
export const readRunFields = (update: Update): ReadonlyMap<string, RunFieldValue> => {
  if (!update.data || typeof update.data !== "object") return new Map();
  const fields = (update.data as { fields?: Record<string, FieldValue> }).fields;
  if (fields === undefined) return new Map();
  return parseContentField(fields[DOC_CONTENT_FIELD]);
};

// ---------------------------------------------------------------------------
// Apply wire Actions to a DocState (read path)
// ---------------------------------------------------------------------------

/**
 * Apply a list of wire-format Actions targeting the given document subject
 * type to a DocState. Returns the new state plus the flat list of DocActions
 * applied (one per run field update) and a parallel `sourceActions` array
 * identifying which input Action each applied DocAction came from.
 *
 * Skips:
 * - Actions whose Updates target a different subject type
 * - Updates whose data doesn't carry a `content` map
 * - Updates with malformed data shapes
 */
export const applyActions = (
  state: DocState,
  actions: readonly Action[],
  docSubjectType: string = DEFAULT_DOC_SUBJECT_TYPE,
): { state: DocState; applied: DocAction[]; sourceActions: Action[] } => {
  let current = state;
  const applied: DocAction[] = [];
  const sourceActions: Action[] = [];

  for (const action of actions) {
    for (const update of action.updates) {
      if (!isDocSubjectUpdate(update, docSubjectType)) continue;

      const runs = readRunFields(update);
      if (runs.size === 0) continue;

      const result = applyRunFieldUpdates(current, runs);
      current = result.state;
      // Each applied DocAction came from this Action. We pair them up so
      // listeners can attribute events to the source action without having
      // to scan the input batch.
      for (const docAction of result.applied) {
        applied.push(docAction);
        sourceActions.push(action);
      }
    }
  }

  return { state: current, applied, sourceActions };
};

/**
 * Apply a single Update to a DocState. Convenience wrapper around
 * applyActions for SSE handlers that work per-event.
 */
export const applyUpdate = (
  state: DocState,
  update: Update,
  docSubjectType: string = DEFAULT_DOC_SUBJECT_TYPE,
): { state: DocState; applied: DocAction[]; sourceActions: Action[] } => {
  const action: Action = {
    id: update.id,
    actor_id: "",
    hlc: "0",
    gsn: 0,
    updates: [update],
  };
  return applyActions(state, [action], docSubjectType);
};

// ---------------------------------------------------------------------------
// Write side: build Update payload from a field-update map
// ---------------------------------------------------------------------------

/**
 * Wrap run-id → field-value entries as the document's `content` map.
 * The map is the wire's unit of per-key merge, so two runs touched by
 * different peers carry different keys.
 */
export const contentFieldFromRuns = (
  runs: Readonly<Record<string, RunFieldValue>>,
): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(runs).map(([runId, field]) => [runId, field as FieldValue]),
  ),
});

/**
 * Helper: build a full Update from a run map. `runs` is keyed by run id;
 * the Update carries them under the document's `content` map field.
 */
export const docActionToUpdate = (
  runs: Readonly<Record<string, RunFieldValue>>,
  opts: { readonly docId: string; readonly updateId: string; readonly docSubjectType?: string },
): Update | null => {
  if (Object.keys(runs).length === 0) return null;
  const subjectType = opts.docSubjectType ?? DEFAULT_DOC_SUBJECT_TYPE;
  return {
    id: opts.updateId,
    subject_id: opts.docId,
    subject_type: subjectType,
    method: "patch",
    data: { fields: { [DOC_CONTENT_FIELD]: contentFieldFromRuns(runs) } },
  };
};

/**
 * Build the very first `content` map for a freshly-created document: one
 * run holding `text`. Used by the derived-body create path so the parent
 * and its document land in the same Action.
 */
export const buildInitialContentField = (
  text: string,
  hlc: HLCTimestamp,
  actorId: string,
  updateId: string,
): FieldValue => {
  const runId = makeRunId(hlc, actorId);
  const node: RunNode = {
    id: runId,
    hlc,
    actorId,
    text,
    parentId: ROOT_ID,
    deleted: false,
  };
  return contentFieldFromRuns({ [runId]: { value: node, update_id: updateId, hlc } });
};

// ---------------------------------------------------------------------------
// Pre/post diff helpers (for local edits → wire payload)
// ---------------------------------------------------------------------------

/**
 * Collect every run that changed between `preState` and `postState`,
 * keyed by run id. A tombstoned run carries `value: null`.
 */
const diffRunMap = (preState: DocState, postState: DocState): Record<string, RunFieldValue> => {
  const runs: Record<string, RunFieldValue> = {};
  const seen = new Set<string>();
  for (const [id, pre] of preState.nodes) {
    if (id === ROOT_ID) continue;
    seen.add(id);
    const post = postState.nodes.get(id);
    if (post && !post.deleted) {
      if (post.text !== pre.text || post.hlc !== pre.hlc || post.actorId !== pre.actorId) {
        runs[id] = { value: post, update_id: "", hlc: post.hlc };
      }
    } else {
      runs[id] = { value: null, update_id: "", hlc: pre.hlc };
    }
  }
  for (const [id, post] of postState.nodes) {
    if (seen.has(id) || id === ROOT_ID) continue;
    if (!post.deleted) {
      runs[id] = { value: post, update_id: "", hlc: post.hlc };
    }
  }
  return runs;
};

/** Stamp each collected run's `update_id` / `hlc` before it reaches the wire. */
const stampRuns = (
  runs: Record<string, RunFieldValue>,
  opts: { readonly updateId: string; readonly hlc: HLCTimestamp },
): Record<string, RunFieldValue> => {
  const out: Record<string, RunFieldValue> = {};
  for (const [runId, field] of Object.entries(runs)) {
    out[runId] = { value: field.value, update_id: opts.updateId, hlc: opts.hlc };
  }
  return out;
};

/**
 * Public helper for callers that want the diff directly (e.g., the
 * TextDocument's localDelete implementation).
 */
export const diffRunFieldsForDeleteRange = (
  preState: DocState,
  postState: DocState,
  opts: { readonly updateId: string; readonly hlc: HLCTimestamp },
): Record<string, RunFieldValue> => stampRuns(diffRunMap(preState, postState), opts);

/**
 * Helper for callers that have applied a local edit (localInsert or
 * localDelete) and want the resulting run map. The caller passes the
 * pre-state and post-state of the tree; this function emits one entry
 * per run that changed between them, keyed by run id.
 */
export const diffRunFields = (
  preState: DocState,
  postState: DocState,
  opts: { readonly updateId: string; readonly hlc: HLCTimestamp },
): Record<string, RunFieldValue> => stampRuns(diffRunMap(preState, postState), opts);
