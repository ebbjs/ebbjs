/**
 * SPIKE S4 (#779): type-level selection, checked by `tsc --noEmit`.
 *
 * Not for merge.
 */

import type { RowRead, Selectable, SelectedRow } from "./select-types";

interface Note {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly content: string;
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T => true as T;

declare const notes: Selectable<Note>;
declare const note: RowRead<Note>;

// A selection narrows the projected row to the selected fields plus `id`.
const selected = notes.select({ title: true, status: true });
type Selected = (typeof selected)[number];
assertTrue<Equal<keyof Selected, "title" | "status" | "id">>();

// A selection of one field keeps only that field.
const one = notes.select({ content: true });
type One = (typeof one)[number];
assertTrue<Equal<keyof One, "content" | "id">>();

// The row read narrows the same way.
type ReadTheTitle = Awaited<ReturnType<typeof note.get<{ title: true }>>>;
assertTrue<Equal<ReadTheTitle, SelectedRow<Note, { title: true }> | null>>();

// @ts-expect-error a field the row does not declare cannot be selected
notes.select({ nope: true });

// @ts-expect-error selecting a component by a non-true value is refused
notes.select({ title: "yes" });

// @ts-expect-error a selection is required to widen a typed row read
note.get("n_1", {});
