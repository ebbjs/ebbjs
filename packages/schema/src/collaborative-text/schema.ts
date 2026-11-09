/**
 * Schema fragments for a collaborative-text document entity.
 *
 * An app declares the document entity itself and links it to the parent with
 * a declared relationship. The entity carries two fields: `content`, a map
 * whose keys are cell ids (`RunCell` or `CutCell`), and `version`, a leaf
 * written by every write so a reader can refuse a cell shape it does not know.
 */

import { Type } from "@sinclair/typebox";

/** Field on the document entity holding the cell map. */
export const DOC_CONTENT_FIELD = "content";

/** Field on the document entity carrying the cell-format version. */
export const DOC_VERSION_FIELD = "version";

/**
 * The cell format this client writes and can read. A document whose
 * `version` is anything else fails the read loudly (#698); there is no
 * legacy projection.
 */
export const CURRENT_TEXT_VERSION = 1;

/** Anchor of a run: a character offset in another run, or the root. */
export const AnchorSchema = Type.Object({
  runId: Type.String(),
  offset: Type.Number(),
});

/**
 * TypeBox shape of an immutable run. Mirrors `RunCell` in `tree.ts`; kept
 * next to the schema layer so the document entity validates like any other
 * field.
 */
export const RunCellSchema = Type.Object({
  kind: Type.Literal("run"),
  id: Type.String(),
  text: Type.String(),
  author: Type.String(),
  stamp: Type.String(),
  anchor: AnchorSchema,
});

/** TypeBox shape of an immutable retraction over one run's characters. */
export const CutCellSchema = Type.Object({
  kind: Type.Literal("cut"),
  id: Type.String(),
  runId: Type.String(),
  from: Type.Number(),
  to: Type.Number(),
  author: Type.String(),
  stamp: Type.String(),
});

/** A cell is either a run or a cut. */
export const TextCellSchema = Type.Union([RunCellSchema, CutCellSchema]);

/**
 * One entry in the `content` map: a cell plus the map key's merge stamp.
 * The key is the cell id, so a write can only ever add a key.
 */
export const CellFieldValueSchema = Type.Object({
  value: TextCellSchema,
  update_id: Type.String(),
  hlc: Type.String(),
});
