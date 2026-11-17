/**
 * The row create: the one Update that brings a row into existence.
 *
 * A row is born in exactly one place on the wire. Its model and its creation
 * time live in the create, so a component write never implies a row and a
 * replica that receives a row through backfill can still date it.
 */

import type { Update } from "@ebbjs/core";

/** The ids a create consumes: its own Update id and the row's creation time. */
export interface RowCreateIds {
  updateId(): string;
  hlc(): string;
}

/** Mint the create for one row of `model`, stamped with the caller's clock. */
export const rowCreate = (subjectId: string, model: string, ids: RowCreateIds): Update => ({
  id: ids.updateId(),
  subject_id: subjectId,
  model,
  method: "create",
  hlc: ids.hlc(),
  data: null,
});
