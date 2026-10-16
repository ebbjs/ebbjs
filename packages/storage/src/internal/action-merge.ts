import type { Update } from "@ebbjs/core";

/**
 * Unions two records for the same Action id.
 *
 * Per-Update delivery (#473) can hand one Action to a client more than
 * once, each copy carrying only the Updates scoped to a different group.
 * Updates are identity-keyed by `update_id`, so the union is the Action's
 * real content no matter how the copies were split. Existing order is
 * preserved; a repeated `update_id` takes the later copy (the two are
 * identical for a genuine re-delivery) and new ids are appended.
 */
export const mergeActionUpdates = (
  existing: readonly Update[],
  incoming: readonly Update[],
): readonly Update[] => {
  const byId = new Map(existing.map((update) => [update.id, update]));
  const order = existing.map((update) => update.id);

  for (const update of incoming) {
    if (!byId.has(update.id)) order.push(update.id);
    byId.set(update.id, update);
  }

  return order.flatMap((id) => {
    const update = byId.get(id);
    return update === undefined ? [] : [update];
  });
};
