/**
 * Wire format adapter — convert between ebb Actions and text cells.
 *
 * ## The document is an entity; cells are the value of its content component
 *
 * A collaborative-text document is an ebb entity whose model is the document
 * model the app declares (a raw document opened directly defaults to
 * `text_document`). Its cells live in one keyed component, `<docModel>/content`,
 * whose value is a map from cell id to
 * `{ value: RunCell | CutCell, update_id, hlc }`.
 *
 * The component is an append-only log, so the merge is per key. Every write
 * only adds keys: a run is never rewritten, a cut is additive, and two
 * peers can never contest one position.
 *
 * Wire-format shape for one edit (one Update in the Action):
 *
 * ```json
 * {
 *   "subject_id": "<docId>",
 *   "component": "text_document/content",
 *   "method": "merge",
 *   "data": {
 *     "map": {
 *       "<cellId>": { "value": <RunCell | CutCell>, "update_id": "...", "hlc": "..." }
 *     }
 *   }
 * }
 * ```
 */

import {
  componentField,
  componentModel,
  componentName,
  isComponentUpdate,
  isFieldLeaf,
  isFieldMap,
  type Action,
  type ComponentUpdate,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";

import {
  applyCellFields,
  makeRunId,
  ROOT_ANCHOR,
  type CellFieldValue,
  type DocState,
  type TextCell,
} from "./tree";
import { AppendOnlyViolationError } from "../log";
import { DOC_CONTENT_FIELD } from "./schema";

export { AppendOnlyViolationError } from "../log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default document model for collaborative-text documents. */
export const DEFAULT_DOC_MODEL = "text_document";

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an Update is a component write to the given document model,
 * narrowing it to a component Update. Use this to filter updates from an
 * Action before applying them to a TextDocument (so non-doc updates pass
 * through unchanged). A `create` and a `delete` name no component and so
 * belong to no single component of the row; neither is a cell delivery.
 */
export const isDocModelUpdate = (update: Update, docModel: string): update is ComponentUpdate =>
  isComponentUpdate(update) && componentModel(update.component) === docModel;

// ---------------------------------------------------------------------------
// Read side: parse a content map into cells
// ---------------------------------------------------------------------------

/**
 * A content map is immutable per version, so its parse is cached by the map
 * field's identity. A merge or a new snapshot produces a new field object; a
 * no-op reuses the old one, which is exactly when the cached parse is still
 * valid. Callers must treat the returned map as read-only, like the field.
 */
const parsedContentFields = new WeakMap<FieldValue, ReadonlyMap<string, CellFieldValue>>();

const isCell = (value: unknown): value is TextCell => {
  if (value === null || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return kind === "run" || kind === "cut";
};

/**
 * Read a document's `content` map into cell-id → field-value entries.
 * Silently ignores non-map `content` values, non-leaf entries, and values
 * that are not a current cell shape: the projection knows one shape only.
 */
export const parseContentField = (content: unknown): ReadonlyMap<string, CellFieldValue> => {
  if (content === undefined || content === null || typeof content !== "object") return new Map();
  const field = content as FieldValue;
  if (!isFieldMap(field)) return new Map();
  const cached = parsedContentFields.get(field);
  if (cached !== undefined) return cached;

  const out = new Map<string, CellFieldValue>();
  for (const [cellId, entry] of Object.entries(field.map)) {
    if (!isFieldLeaf(entry)) continue;
    if (!isCell(entry.value)) continue;
    const update_id = typeof entry.update_id === "string" ? entry.update_id : "";
    const hlc = typeof entry.hlc === "string" ? entry.hlc : ("0" as HLCTimestamp);
    out.set(cellId, { value: entry.value, update_id, hlc });
  }
  parsedContentFields.set(field, out);
  return out;
};

// ---------------------------------------------------------------------------
// Apply wire Actions to a DocState (read path)
// ---------------------------------------------------------------------------

/** One delivered cell, paired with the Action it arrived in. */
export type AppliedCell = {
  readonly cellId: string;
  readonly cell: TextCell;
};

/**
 * Apply a list of wire-format Actions targeting the given document subject
 * type to a DocState. Returns the re-projected state plus the cells that
 * were newly delivered and the Action each came from.
 *
 * This is delivery, not state: it merges the cells and re-projects. Skips
 * Actions targeting another subject type and Updates without a `content`
 * map.
 */
export const applyActions = (
  state: DocState,
  actions: readonly Action[],
  docModel: string = DEFAULT_DOC_MODEL,
): { state: DocState; applied: AppliedCell[]; sourceActions: Action[] } => {
  let current = state;
  const applied: AppliedCell[] = [];
  const sourceActions: Action[] = [];

  for (const action of actions) {
    for (const update of action.updates) {
      if (!isDocModelUpdate(update, docModel)) continue;

      if (update.method === "drop") continue;
      const field = componentField(update.component);
      if (field !== DOC_CONTENT_FIELD) continue;

      const cells = parseContentField(update.data);
      if (cells.size === 0) continue;

      const before = current.cells;
      current = applyCellFields(current, cells);
      for (const [cellId, field] of cells) {
        if (before.has(cellId)) continue;
        applied.push({ cellId, cell: field.value });
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
  docModel: string = DEFAULT_DOC_MODEL,
): { state: DocState; applied: AppliedCell[]; sourceActions: Action[] } => {
  const action: Action = {
    id: update.id,
    actor_id: "",
    hlc: "0",
    gsn: 0,
    updates: [update],
  };
  return applyActions(state, [action], docModel);
};

// ---------------------------------------------------------------------------
// Write side: build Update payload from cells
// ---------------------------------------------------------------------------

/**
 * Wrap cells as the document's `content` map. Every entry carries the cell's
 * own stamp, so the map's per-key merge and the cell's provenance agree.
 */
export const contentFieldFromCells = (
  cells: readonly TextCell[],
  updateId: string,
): FieldValue => ({
  map: Object.fromEntries(
    cells.map((cell) => [
      cell.id,
      { value: cell, update_id: updateId, hlc: cell.stamp } as FieldValue,
    ]),
  ),
});

/**
 * Build the one Update one edit emits: the new cells in the document's
 * `content` log component.
 */
export const docActionToUpdate = (
  cells: readonly TextCell[],
  opts: { readonly docId: string; readonly updateId: string; readonly docModel?: string },
): Update[] | null => {
  if (cells.length === 0) return null;
  const docModel = opts.docModel ?? DEFAULT_DOC_MODEL;
  return [
    {
      id: opts.updateId,
      subject_id: opts.docId,
      component: componentName(docModel, DOC_CONTENT_FIELD),
      method: "merge",
      data: contentFieldFromCells(cells, opts.updateId),
    },
  ];
};

/**
 * Build the first component values for a freshly-created document: one run
 * holding `text` in the content log.
 */
export const buildInitialDocumentFields = (
  text: string,
  hlc: HLCTimestamp,
  actorId: string,
  updateId: string,
): Record<string, FieldValue> => {
  const run: TextCell = {
    kind: "run",
    id: makeRunId(hlc, actorId),
    text,
    author: actorId,
    stamp: hlc,
    anchor: ROOT_ANCHOR,
  };
  return {
    [DOC_CONTENT_FIELD]: {
      map: {
        [run.id]: { value: run, update_id: updateId, hlc } as FieldValue,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Write discipline
// ---------------------------------------------------------------------------

/**
 * The append-only rule as a pure check. `incoming` are the keys a batch
 * would write; `existing` are the keys already present. A batch may only
 * add.
 */
export const appendOnlyViolations = (
  incoming: Iterable<string>,
  existing: Iterable<string>,
): readonly string[] => {
  const present = new Set(existing);
  const violated: string[] = [];
  for (const key of incoming) {
    if (present.has(key)) violated.push(key);
  }
  return violated;
};

/** Throw {@link AppendOnlyViolationError} if a batch rewrites a cell key. */
export const assertAppendOnly = (
  component: string,
  incoming: Iterable<string>,
  existing: Iterable<string>,
): void => {
  const violated = appendOnlyViolations(incoming, existing);
  if (violated.length > 0) throw new AppendOnlyViolationError(component, violated);
};
