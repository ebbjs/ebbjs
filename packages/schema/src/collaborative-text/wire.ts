/**
 * Wire format adapter — convert between ebb Actions and text cells.
 *
 * ## The document is an entity; cells are the value of its content component
 *
 * A collaborative-text document is an ebb entity whose model is the document
 * model the app declares (a raw document opened directly defaults to
 * `text_document`). Its cells live in one keyed component, `<docType>/content`,
 * whose value is a map from cell id to
 * `{ value: RunCell | CutCell, update_id, hlc }`.
 *
 * The component is a *keyed* component, so the merge is per key. Every write
 * only adds keys: a run is never rewritten, a cut is additive, and two
 * peers can never contest one position. The body's `version` leaf travels
 * with every write, in its own `<docType>/version` Update, so a reader can
 * refuse a cell shape it does not know.
 *
 * Wire-format shape for one edit (two Updates in the same Action):
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
 * { "subject_id", "component": "text_document/version", "method": "merge",
 *   "data": { "value": 1, "update_id": "...", "hlc": "..." } }
 * ```
 */

import {
  componentField,
  componentModel,
  componentName,
  isFieldLeaf,
  isFieldMap,
  type Action,
  type FieldValue,
  type HLCTimestamp,
  type Update,
} from "@ebbjs/core";

import {
  applyCellFields,
  cellValuesEqual,
  makeRunId,
  ROOT_ANCHOR,
  type CellFieldValue,
  type DocState,
  type TextCell,
} from "./tree";
import { CURRENT_TEXT_VERSION, DOC_CONTENT_FIELD, DOC_VERSION_FIELD } from "./schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default document model for collaborative-text documents. */
export const DEFAULT_DOC_SUBJECT_TYPE = "text_document";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** A document declares a cell format this client cannot read. */
export class DocumentVersionError extends Error {
  readonly found: unknown;
  readonly expected: number;

  constructor(found: unknown, expected: number = CURRENT_TEXT_VERSION) {
    super(
      `collaborative-text: document version ${String(found)} is not readable by this client ` +
        `(expected ${expected})`,
    );
    this.name = "DocumentVersionError";
    this.found = found;
    this.expected = expected;
  }
}

/**
 * Read a document's `version` leaf. Absent means the current version: a
 * freshly-seeded document may carry no content yet, and every real write
 * stamps the leaf. Any other value fails loudly rather than projecting a
 * wrong view.
 */
export const assertKnownVersion = (field: FieldValue | undefined): void => {
  if (field === undefined) return;
  if (!isFieldLeaf(field)) throw new DocumentVersionError(field);
  if (field.value !== CURRENT_TEXT_VERSION) throw new DocumentVersionError(field.value);
};

/** Build the `version` leaf a write carries. */
export const versionField = (
  hlc: HLCTimestamp,
  updateId: string,
  version: number = CURRENT_TEXT_VERSION,
): FieldValue => ({ value: version, update_id: updateId, hlc });

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an Update targets the given document model. Use this to
 * filter updates from an Action before applying them to a TextDocument (so
 * non-doc updates pass through unchanged). A `delete` names no component and
 * so belongs to no single component of the row; it is not a cell delivery.
 */
export const isDocSubjectUpdate = (update: Update, docSubjectType: string): boolean =>
  update.method !== "delete" && componentModel(update.component) === docSubjectType;

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

/** The raw keys of a `content` map, ignoring their values. */
export const contentKeys = (content: unknown): readonly string[] => {
  if (content === null || typeof content !== "object" || !("map" in content)) return [];
  const map = (content as { map: unknown }).map;
  if (map === null || typeof map !== "object") return [];
  return Object.keys(map);
};

/**
 * Read the cells out of an Update that carries the document's `content`
 * component. Exported so the conflict path and the wire adapter unwrap the
 * envelope consistently.
 */
export const readCellFields = (update: Update): ReadonlyMap<string, CellFieldValue> => {
  if (update.method === "drop" || update.method === "delete") return new Map();
  if (componentField(update.component) !== DOC_CONTENT_FIELD) return new Map();
  return parseContentField(update.data);
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
 * map. Throws {@link DocumentVersionError} for an unknown version.
 */
export const applyActions = (
  state: DocState,
  actions: readonly Action[],
  docSubjectType: string = DEFAULT_DOC_SUBJECT_TYPE,
): { state: DocState; applied: AppliedCell[]; sourceActions: Action[] } => {
  let current = state;
  const applied: AppliedCell[] = [];
  const sourceActions: Action[] = [];

  for (const action of actions) {
    for (const update of action.updates) {
      if (!isDocSubjectUpdate(update, docSubjectType)) continue;

      if (update.method === "drop" || update.method === "delete") continue;
      const field = componentField(update.component);
      if (field === DOC_VERSION_FIELD) {
        assertKnownVersion(update.data);
        continue;
      }
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
  docSubjectType: string = DEFAULT_DOC_SUBJECT_TYPE,
): { state: DocState; applied: AppliedCell[]; sourceActions: Action[] } => {
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
 * Build the two Updates one edit emits: the new cells in the document's
 * `content` component, and the body's `version` leaf beside them, so every
 * write declares its cell format.
 */
export const docActionToUpdate = (
  cells: readonly TextCell[],
  opts: { readonly docId: string; readonly updateId: string; readonly docSubjectType?: string },
): Update[] | null => {
  if (cells.length === 0) return null;
  const docType = opts.docSubjectType ?? DEFAULT_DOC_SUBJECT_TYPE;
  const versionUpdateId = `${opts.updateId}v`;
  return [
    {
      id: opts.updateId,
      subject_id: opts.docId,
      component: componentName(docType, DOC_CONTENT_FIELD),
      method: "merge",
      data: contentFieldFromCells(cells, opts.updateId),
    },
    {
      id: versionUpdateId,
      subject_id: opts.docId,
      component: componentName(docType, DOC_VERSION_FIELD),
      method: "merge",
      data: versionField(hlcOf(cells), versionUpdateId),
    },
  ];
};

const hlcOf = (cells: readonly TextCell[]): HLCTimestamp => cells[0]!.stamp;

/**
 * Build the first component values for a freshly-created document: one run
 * holding `text` in the content component, plus the version leaf.
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
    [DOC_VERSION_FIELD]: versionField(hlc, updateId),
  };
};

// ---------------------------------------------------------------------------
// Write discipline
// ---------------------------------------------------------------------------

/** A write tried to rewrite a `content` key that already exists. */
export class AppendOnlyViolationError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(
      `collaborative-text: refusing to rewrite existing content ${keys.length === 1 ? "key" : "keys"} ` +
        `${keys.map((key) => JSON.stringify(key)).join(", ")}; ` +
        "a text body's content map is append-only",
    );
    this.name = "AppendOnlyViolationError";
    this.keys = keys;
  }
}

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
export const assertAppendOnly = (incoming: Iterable<string>, existing: Iterable<string>): void => {
  const violated = appendOnlyViolations(incoming, existing);
  if (violated.length > 0) throw new AppendOnlyViolationError(violated);
};

/**
 * The append-only rule over cell values: a key that already exists may only
 * be re-delivered unchanged. An identical value is the same cell (idempotent
 * re-delivery, or a local edit the optimistic state already carries); a
 * different value under an existing key is a rewrite.
 */
export const appendOnlyRewrites = (
  incoming: ReadonlyMap<string, CellFieldValue>,
  existing: ReadonlyMap<string, CellFieldValue>,
): readonly string[] => {
  const violated: string[] = [];
  for (const [id, cell] of incoming) {
    const previous = existing.get(id);
    if (previous === undefined) continue;
    if (!cellValuesEqual(previous.value, cell.value)) violated.push(id);
  }
  return violated;
};
