/**
 * SPIKE S4 (#779): the typed half of a selection.
 *
 * A row projection is the shape minus the fields the caller did not select.
 * Throwaway; checked by `tsc`, never imported.
 */

/** One field of a row. */
export interface RowLike {
  readonly id: string;
}

/** The row a selection projects: exactly the selected fields, then `id`. */
export type SelectedRow<TRow extends RowLike, TSelection> = {
  readonly [K in keyof TSelection & keyof TRow]: TRow[K];
} & { readonly id: string };

/** A chain that can narrow its projection. */
export interface Selectable<TRow extends RowLike> {
  select<TSelection extends { readonly [K in keyof TRow]?: true }>(
    selection: TSelection,
  ): readonly SelectedRow<TRow, TSelection>[];
}

/** A read of one row: the selection narrows it the same way. */
export interface RowRead<TRow extends RowLike> {
  get<TSelection extends { readonly [K in keyof TRow]?: true }>(
    id: string,
    options: { readonly components: TSelection },
  ): Promise<SelectedRow<TRow, TSelection> | null>;
}
