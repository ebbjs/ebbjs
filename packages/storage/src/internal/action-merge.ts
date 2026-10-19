import type { Update } from "@ebbjs/core";

/**
 * Unions two records for the same Action id.
 *
 * Per-Update delivery (#473) can hand one Action to a client more than
 * once, each copy carrying only the Updates scoped to a different group.
 * Updates are identity-keyed by `update_id`, and a repeated id takes the
 * later copy (identical for a genuine re-delivery).
 */
export const mergeActionUpdates = (
  existing: readonly Update[],
  incoming: readonly Update[],
): Update[] => {
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

/**
 * The Updates in `incoming` whose id is not already stored. For a repeated
 * Action id (#473) this is the delta a fold may apply: the rest are copies
 * of Updates already in the base, and re-applying them can revert a newer
 * write. A first delivery passes `existing` as `[]`.
 */
export const addedUpdates = (
  existing: readonly Update[],
  incoming: readonly Update[],
): readonly Update[] => {
  const known = new Set(existing.map((update) => update.id));
  return incoming.filter((update) => !known.has(update.id));
};
