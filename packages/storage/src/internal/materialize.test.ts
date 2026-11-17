import { describe, expect, it } from "vitest";
import { componentName, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";
import { applyUpdate, foldEntityAction, foldEntityActions } from "./materialize";

const leaf = (value: unknown, hlc: string, updateId: string): FieldValue => ({
  value,
  update_id: updateId,
  hlc,
});

const entity = (): Entity => ({
  id: "doc_1",
  model: "doc",
  data: {
    fields: {
      content: { map: { a: leaf("a", "1", "u_a"), b: leaf("b", "1", "u_b") } },
    },
  },
  exists: true,
  created_hlc: "1",
  updated_hlc: "5",
  deleted_hlc: null,
  last_gsn: 1,
});

/** The row create: its model and its creation time, and no component. */
const create = (subjectId = "doc_1", model = "doc", hlc = "2"): Update => ({
  id: `upd_create_${subjectId}`,
  subject_id: subjectId,
  model,
  method: "create",
  hlc,
  data: null,
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

const drop = (subjectId = "doc_1", field = "title"): Update => ({
  id: `upd_drop_${subjectId}_${field}`,
  subject_id: subjectId,
  component: componentName("doc", field),
  method: "drop",
  data: null,
});

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
 * The create is the row's existence and its creation time, delivered as its
 * own Update so a row with no components has somewhere to exist.
 */
describe("the row create", () => {
  it("materializes a live row with no components", () => {
    const row = applyUpdate(null, create("doc_1", "doc", "4"), 2, "3");

    expect(row).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: {} },
      exists: true,
      created_hlc: "4",
      updated_hlc: "3",
      deleted_hlc: null,
      last_gsn: 2,
    });
  });

  it("is idempotent: a duplicate create does not restate the row", () => {
    const base = applyUpdate(null, create("doc_1", "doc", "4"), 2, "3");

    const again = applyUpdate(base, create("doc_1", "other", "9"), 5, "9");

    expect(again).toEqual({ ...base, updated_hlc: "9", last_gsn: 5 });
  });

  it("does not resurrect a tombstoned row", () => {
    const base = applyUpdate(null, create("doc_1", "doc", "2"), 1, "2");
    const tombstoned = applyUpdate(base, remove(), 2, "3")!;

    const again = applyUpdate(tombstoned, create("doc_1", "doc", "4"), 3, "4");

    expect(again).toEqual({ ...tombstoned, updated_hlc: "4", last_gsn: 3 });
    expect(again!.deleted_hlc).toBe("3");
  });

  it("adopts a placeholder's existence, creation time and model, keeping its fields", () => {
    const placeholder = applyUpdate(
      null,
      update("replace", { title: leaf("Early", "1", "u_early") }),
      1,
      "1",
    )!;
    expect(placeholder.exists).toBe(false);

    const adopted = applyUpdate(placeholder, create("doc_1", "note", "6"), 4, "6");

    expect(adopted).toEqual({
      ...placeholder,
      model: "note",
      exists: true,
      created_hlc: "6",
      updated_hlc: "6",
      last_gsn: 4,
    });
    expect(adopted!.data).toBe(placeholder.data);
  });

  it("keeps a live row alive when its last component is dropped", () => {
    const row = fold([
      action(1, [create("doc_1", "doc", "1"), update("replace", { title: leaf("t", "1", "u_t") })]),
      action(2, [drop()]),
    ]);

    expect(row).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: {} },
      exists: true,
      created_hlc: "1",
      updated_hlc: "2",
      deleted_hlc: null,
      last_gsn: 2,
    });
  });
});

/**
 * A component write never invents a row: it materializes a placeholder whose
 * create has not been seen, which is what makes the row a backfill candidate.
 */
describe("a component write with no create", () => {
  it("materializes a placeholder that never sets existence", () => {
    const row = applyUpdate(
      null,
      update("replace", { title: leaf("Early", "1", "u_early") }),
      3,
      "3",
    );

    expect(row).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: { title: leaf("Early", "1", "u_early") } },
      exists: false,
      created_hlc: null,
      updated_hlc: "3",
      deleted_hlc: null,
      last_gsn: 3,
    });
  });
});

describe("foldEntityAction", () => {
  it("folds only this subject's updates, in order", () => {
    const folded = foldEntityAction(
      null,
      "doc_1",
      action(12, [
        create("doc_1", "doc", "3"),
        update("replace", { title: leaf("t", "9", "u_t") }),
        update("replace", { content: leaf("other", "9", "u_other") }, "doc_2"),
        update("merge", { content: leaf("c", "10", "u_c") }),
      ]),
    );

    expect(folded).toEqual({
      id: "doc_1",
      model: "doc",
      data: {
        fields: { title: leaf("t", "9", "u_t"), content: leaf("c", "10", "u_c") },
      },
      exists: true,
      created_hlc: "3",
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
      action(3, [
        create("doc_1", "doc", "2"),
        update("replace", { title: leaf("first", "3", "u_put") }),
      ]),
      action(7, [update("merge", { title: leaf("second", "7", "u_patch") })]),
      action(9, [remove()]),
    ]);

    expect(folded).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: { title: leaf("second", "7", "u_patch") } },
      exists: true,
      created_hlc: "2",
      updated_hlc: "9",
      deleted_hlc: "9",
      last_gsn: 9,
    });
  });

  it("a drop after a delete leaves the tombstone alone", () => {
    const folded = fold([
      action(3, [
        create("doc_1", "doc", "2"),
        update("replace", { title: leaf("first", "3", "u_put") }),
      ]),
      action(4, [remove()]),
      action(5, [drop()]),
    ]);

    // Detaching a component is not a resurrection: the row stays tombstoned,
    // which is what the server's materialization does too.
    expect(folded).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: {} },
      exists: true,
      created_hlc: "2",
      updated_hlc: "5",
      deleted_hlc: "4",
      last_gsn: 5,
    });
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
        action(3, [
          create("doc_1", "doc", "1"),
          update("replace", { title: leaf("first", "3", "u_put") }),
        ]),
        action(5, [update("merge", { title: leaf("other", "5", "u_other") }, "doc_2")]),
        action(7, [update("merge", { title: leaf("third", "7", "u_patch") })]),
      ],
      "doc_1",
    );

    expect(folded).toEqual({
      id: "doc_1",
      model: "doc",
      data: { fields: { title: leaf("third", "7", "u_patch") } },
      exists: true,
      created_hlc: "1",
      updated_hlc: "7",
      deleted_hlc: null,
      last_gsn: 7,
    });
  });
});
