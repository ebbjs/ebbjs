import { describe, expect, it } from "vitest";
import { componentName, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";
import { applyUpdate, foldEntityAction, foldEntityActions, mergeFields } from "./materialize";

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

const entity = (): Entity => ({
  id: "doc_1",
  type: "doc",
  data: {
    fields: {
      content: { map: { a: leaf("a", "1", "u_a"), b: leaf("b", "1", "u_b") } },
    },
  },
  created_hlc: "1",
  updated_hlc: "5",
  deleted_hlc: null,
  last_gsn: 1,
});

/** A `merge` of the `doc/content` component. */
const patch = (content: FieldValue): Update => ({
  id: "upd_1",
  subject_id: "doc_1",
  component: componentName("doc", "content"),
  method: "merge",
  data: content,
});

const update = (
  method: "merge" | "replace",
  fields: Record<string, FieldValue>,
  subjectId = "doc_1",
): Update => {
  const [field, value] = Object.entries(fields)[0]!;
  return {
    id: `upd_${method}_${subjectId}`,
    subject_id: subjectId,
    component: componentName("doc", field!),
    method,
    data: value!,
  };
};

const remove = (subjectId = "doc_1"): Update => ({
  id: `upd_delete_${subjectId}`,
  subject_id: subjectId,
  method: "delete",
  data: null,
});

const action = (gsn: number, updates: readonly Update[]): Action => ({
  id: `act_${gsn}`,
  actor_id: "user_1",
  hlc: `${gsn}`,
  gsn,
  updates: [...updates],
});

const fold = (actions: readonly Action[], initial: Entity | null = null): Entity | null =>
  actions.reduce((row, next) => foldEntityAction(row, "doc_1", next), initial);

/**
 * A patch that changes nothing must not allocate a new field map, so the
 * read model can use `data` reference identity as its change signal instead
 * of rescanning the map.
 */
describe("mergeFields reference reuse", () => {
  it("returns the existing data when the patch loses", () => {
    const base = entity();
    const write = {
      field: "content",
      method: "merge" as const,
      value: { map: { a: leaf("x", "0", "u_x") } },
    };
    expect(mergeFields(base.data, write)).toBe(base.data);
  });

  it("returns new data when a key wins", () => {
    const base = entity();
    const write = {
      field: "content",
      method: "merge" as const,
      value: { map: { a: leaf("new", "9", "u_x") } },
    };
    const merged = mergeFields(base.data, write);

    expect(merged).not.toBe(base.data);
    expect(merged.fields.content).not.toBe(base.data.fields.content);
    expect(merged).toEqual({
      fields: {
        content: { map: { a: leaf("new", "9", "u_x"), b: leaf("b", "1", "u_b") } },
      },
    });
  });
});

describe("applyUpdate reference reuse", () => {
  it("reuses the data object on a losing patch while advancing bookkeeping", () => {
    const base = entity();
    const next = applyUpdate(base, patch({ map: { a: leaf("x", "0", "u_x") } }), 2, "0");

    expect(next).not.toBeNull();
    expect(next!.data).toBe(base.data);
    // The delivery cursor still advances; only observable content is reused.
    expect(next!.last_gsn).toBe(2);
    expect(next!.updated_hlc).toBe("5");
  });

  it("produces new data on a winning patch and keeps the result LWW-correct", () => {
    const base = entity();
    const next = applyUpdate(base, patch({ map: { a: leaf("new", "9", "u_x") } }), 2, "9");

    expect(next!.data).not.toBe(base.data);
    expect(next).toEqual({
      ...base,
      data: {
        fields: {
          content: { map: { a: leaf("new", "9", "u_x"), b: leaf("b", "1", "u_b") } },
        },
      },
      updated_hlc: "9",
      last_gsn: 2,
    });
  });
});

/**
 * The fold an entity store runs over one Action for one subject: every Update
 * addressed to that subject, in `updates` order, on top of the row so far.
 */
describe("foldEntityAction", () => {
  it("folds only this subject's updates, in order", () => {
    const folded = foldEntityAction(
      null,
      "doc_1",
      action(12, [
        update("replace", { title: leaf("t", "9", "u_t") }),
        update("replace", { content: leaf("other", "9", "u_other") }, "doc_2"),
        update("merge", { content: leaf("c", "10", "u_c") }),
      ]),
    );

    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: {
        fields: { title: leaf("t", "9", "u_t"), content: leaf("c", "10", "u_c") },
      },
      created_hlc: "12",
      updated_hlc: "12",
      deleted_hlc: null,
      last_gsn: 12,
    });
  });

  it("keeps a null row when no update matches the subject", () => {
    const folded = foldEntityAction(
      null,
      "doc_1",
      action(4, [update("replace", { content: leaf("other", "1", "u_other") }, "doc_2")]),
    );

    expect(folded).toBeNull();
  });

  it("tombstones the row after create, merge and delete", () => {
    const folded = fold([
      action(3, [update("replace", { title: leaf("first", "3", "u_put") })]),
      action(7, [update("merge", { title: leaf("second", "7", "u_patch") })]),
      action(9, [remove()]),
    ]);

    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: { fields: { title: leaf("second", "7", "u_patch") } },
      created_hlc: "3",
      updated_hlc: "9",
      deleted_hlc: "9",
      last_gsn: 9,
    });
  });

  it("creates the row from a merge with no base row and leaves created_hlc unset", () => {
    const folded = foldEntityAction(
      null,
      "doc_1",
      action(5, [update("merge", { title: leaf("late", "5", "u_late") })]),
    );

    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: { fields: { title: leaf("late", "5", "u_late") } },
      created_hlc: "",
      updated_hlc: "5",
      deleted_hlc: null,
      last_gsn: 5,
    });
  });

  it("drops a component and leaves the row", () => {
    const folded = fold([
      action(3, [update("replace", { title: leaf("first", "3", "u_put") })]),
      action(4, [
        {
          id: "upd_drop",
          subject_id: "doc_1",
          component: componentName("doc", "title"),
          method: "drop",
          data: null,
        },
      ]),
    ]);

    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: { fields: {} },
      created_hlc: "3",
      updated_hlc: "4",
      deleted_hlc: null,
      last_gsn: 4,
    });
  });

  it("a drop after a delete leaves the tombstone alone", () => {
    const folded = fold([
      action(3, [update("replace", { title: leaf("first", "3", "u_put") })]),
      action(4, [remove()]),
      action(5, [
        {
          id: "upd_drop",
          subject_id: "doc_1",
          component: componentName("doc", "title"),
          method: "drop",
          data: null,
        },
      ]),
    ]);

    // Detaching a component is not a resurrection: the row stays tombstoned,
    // which is what the server's materialization does too.
    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: { fields: {} },
      created_hlc: "3",
      updated_hlc: "5",
      deleted_hlc: "4",
      last_gsn: 5,
    });
  });

  it("keeps the existing row's type on a delete", () => {
    const folded = fold([
      action(3, [update("replace", { title: leaf("first", "3", "u_put") })]),
      action(9, [remove()]),
    ]);

    expect(folded!.type).toBe("doc");
  });
});

/**
 * The whole-read fold both entity stores replay: the same per-subject fold,
 * applied across the Actions `getForEntity` returned.
 */
describe("foldEntityActions", () => {
  it("folds a whole read for one subject in the given order", () => {
    const folded = foldEntityActions(
      [
        action(3, [update("replace", { title: leaf("first", "3", "u_put") })]),
        action(5, [update("merge", { title: leaf("other", "5", "u_other") }, "doc_2")]),
        action(7, [update("merge", { title: leaf("third", "7", "u_patch") })]),
      ],
      "doc_1",
    );

    expect(folded).toEqual({
      id: "doc_1",
      type: "doc",
      data: { fields: { title: leaf("third", "7", "u_patch") } },
      created_hlc: "3",
      updated_hlc: "7",
      deleted_hlc: null,
      last_gsn: 7,
    });
  });

  it("returns null when no Action touches the subject", () => {
    const folded = foldEntityActions(
      [action(4, [update("replace", { content: leaf("other", "1", "u_other") }, "doc_2")])],
      "doc_1",
    );

    expect(folded).toBeNull();
  });
});
