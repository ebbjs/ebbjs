/**
 * Wire format adapter — convert between ebb Actions and tree DocActions.
 *
 * ## Design: runs are fields of the document
 *
 * A collaborative-text document is an ebb entity of type `text_document`
 * (configurable). Each run is a field on that entity, named `run:<runId>`.
 * This keeps the doc as the only entity the server ever sees — runs never
 * appear as separate entities, so the server's permission model
 * (`<type>.<verb>` scoped per group) gates the whole document with a
 * single grant: `text_document.update` (or `text_document.*`) covers all
 * run operations.
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
 *       "run:<runId>": {
 *         "value": <RunNode | null>,
 *         "update_id": "<update-id>",
 *         "hlc": "<hlc>"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * - `method: "patch"` always — storage's per-field LWW merge handles
 *   insert/update of any run field, including new ones.
 * - `value: null` is the tombstone encoding. The receiver drops the run
 *   from its tree.
 * - SPLITs are local-only consequences — the wire carries the resulting
 *   field updates (split halves + any tombstones) as a flat list. The
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

import type { Action, HLCTimestamp, Update } from "@ebbjs/core";
import {
  applyRunFieldUpdates,
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

/**
 * Field-name prefix for run fields on the document. The receiver parses
 * the run id from the suffix.
 *
 * Field names take the shape `run:<runId>` where `<runId>` is the full
 * run ID (`${formatHlc(hlc)}:${actorId}`, possibly followed by `:s:<offset>`
 * for split halves).
 */
export const RUN_FIELD_PREFIX = "run:";

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

/**
 * Parse a `run:<runId>` field name into the run id. Returns null if the
 * field name doesn't have the run prefix.
 */
export const parseRunFieldName = (fieldName: string): string | null => {
  if (!fieldName.startsWith(RUN_FIELD_PREFIX)) return null;
  return fieldName.slice(RUN_FIELD_PREFIX.length);
};

/**
 * Build a `run:<runId>` field name from a run id.
 */
export const formatRunFieldName = (runId: string): string => `${RUN_FIELD_PREFIX}${runId}`;

// ---------------------------------------------------------------------------
// Read side: parse incoming wire updates into field-update operations
// ---------------------------------------------------------------------------

/** A single run field read out of an Update's data. */
type ParsedField = {
  readonly fieldName: string;
  readonly runId: string;
  readonly field: RunFieldValue;
  readonly updateId: string;
  readonly updateHlc: HLCTimestamp;
};

/**
 * Read the fields out of an Update that target runs. Silently ignores
 * fields with names that don't start with the run prefix (so non-run
 * fields on the doc — e.g., a `title` field — pass through untouched).
 *
 * Exported because the conflict detector also needs to walk the wire
 * format to know which Update touched which run — there's no other
 * surface that exposes this mapping. Keeping the read logic in one
 * place ensures both code paths unwrap `data.fields` consistently.
 */
export const readRunFields = (update: Update): ParsedField[] => {
  if (!update.data || typeof update.data !== "object") return [];
  // Wire format: user-entity fields are nested under `data.fields`.
  // Tolerate the unwrapped shape too (older peers / older tests).
  const dataObj = update.data as Record<string, Record<string, unknown>>;
  const fields =
    (dataObj["fields"] as Record<string, Record<string, unknown>> | undefined) ?? dataObj;
  const out: ParsedField[] = [];
  for (const [fieldName, field] of Object.entries(fields)) {
    const parsed = parseRunFieldName(fieldName);
    if (!parsed) continue;
    if (!field || typeof field !== "object") continue;
    const value = field["value"];
    const update_id =
      typeof field["update_id"] === "string" ? (field["update_id"] as string) : update.id;
    const hlc =
      typeof field["hlc"] === "string" ? (field["hlc"] as HLCTimestamp) : ("0" as HLCTimestamp);
    if (value === null) {
      out.push({
        fieldName,
        runId: parsed,
        field: { value: null, update_id, hlc },
        updateId: update.id,
        updateHlc: hlc,
      });
    } else if (value && typeof value === "object" && "id" in value) {
      out.push({
        fieldName,
        runId: parsed,
        field: { value: value as RunNode, update_id, hlc },
        updateId: update.id,
        updateHlc: hlc,
      });
    }
  }
  return out;
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
 * - Updates whose data doesn't carry `run:*` fields
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

      const parsed = readRunFields(update);
      if (parsed.length === 0) continue;

      const updates = new Map<string, RunFieldValue>();
      for (const p of parsed) {
        updates.set(p.runId, p.field);
      }

      const result = applyRunFieldUpdates(current, updates);
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
 * Helper: build a full Update from a DocAction and field-update payload.
 */
export const docActionToUpdate = (
  action: DocAction,
  fieldUpdates: Record<string, RunFieldValue>,
  opts: { readonly docId: string; readonly updateId: string; readonly docSubjectType?: string },
): Update | null => {
  if (Object.keys(fieldUpdates).length === 0) return null;
  const subjectType = opts.docSubjectType ?? DEFAULT_DOC_SUBJECT_TYPE;
  return {
    id: opts.updateId,
    subject_id: opts.docId,
    subject_type: subjectType,
    method: "patch",
    // Wire format: user-entity fields are nested under `data.fields`
    // so the server's per-field LWW merge handles each run independently.
    data: { fields: fieldUpdates } as unknown as never,
  };
};

// ---------------------------------------------------------------------------
// Pre/post diff helpers (for local edits → wire payload)
// ---------------------------------------------------------------------------

/**
 * Public helper for callers that want the diff directly (e.g., the
 * TextDocument's localDelete implementation).
 */
export const diffRunFieldsForDeleteRange = (
  preState: DocState,
  postState: DocState,
  opts: { readonly updateId: string; readonly hlc: HLCTimestamp },
): Record<string, RunFieldValue> => {
  const fields: Record<string, RunFieldValue> = {};
  const seen = new Set<string>();
  for (const [id, pre] of preState.nodes) {
    if (id === "ROOT") continue;
    seen.add(id);
    const post = postState.nodes.get(id);
    if (post && !post.deleted) {
      if (post.text !== pre.text || post.hlc !== pre.hlc) {
        fields[formatRunFieldName(id)] = {
          value: post,
          update_id: opts.updateId,
          hlc: opts.hlc,
        };
      }
    } else {
      fields[formatRunFieldName(id)] = {
        value: null,
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
    }
  }
  for (const [id, post] of postState.nodes) {
    if (seen.has(id) || id === "ROOT") continue;
    if (!post.deleted) {
      fields[formatRunFieldName(id)] = {
        value: post,
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
    }
  }
  return fields;
};

/**
 * Helper for callers that have applied a local edit (localInsert or
 * localDelete) and want the resulting field-update wire payload.
 *
 * The caller passes the pre-state and post-state of the tree; this
 * function emits one entry per run that changed between them.
 */
export const diffRunFields = (
  preState: DocState,
  postState: DocState,
  opts: { readonly updateId: string; readonly hlc: HLCTimestamp },
): Record<string, RunFieldValue> => {
  const fields: Record<string, RunFieldValue> = {};
  const seen = new Set<string>();
  for (const [id, pre] of preState.nodes) {
    if (id === "ROOT") continue;
    seen.add(id);
    const post = postState.nodes.get(id);
    if (post && !post.deleted) {
      if (post.text !== pre.text || post.hlc !== pre.hlc || post.actorId !== pre.actorId) {
        fields[formatRunFieldName(id)] = {
          value: post,
          update_id: opts.updateId,
          hlc: opts.hlc,
        };
      }
    } else {
      fields[formatRunFieldName(id)] = {
        value: null,
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
    }
  }
  for (const [id, post] of postState.nodes) {
    if (seen.has(id) || id === "ROOT") continue;
    if (!post.deleted) {
      fields[formatRunFieldName(id)] = {
        value: post,
        update_id: opts.updateId,
        hlc: opts.hlc,
      };
    }
  }
  return fields;
};
