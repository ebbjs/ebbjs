import { componentName, type Entity } from "@ebbjs/core";

import { sortSourceIds } from "./reverse-index";

/**
 * Presence over the composed view: which components (`<type>/<field>`) each
 * materialized row currently carries.
 *
 * A row's component set is the set of keys in `data.fields` — one row has one
 * model, so each present field names exactly one component. A dropped
 * component is a missing key, which is what makes presence a fact about the
 * row rather than a value stored in it.
 *
 * In memory only: the replica rebuilds it from the rows on load, like the
 * adjacency indices, and #799 owns the durable index that replaces it.
 */

/** Component name → ids currently carrying it. */
export type PresenceIndex = Map<string, Set<string>>;

/** The component names a row carries, one per present field of its type. */
export const componentsOf = (entity: Entity): readonly string[] =>
  Object.keys(entity.data?.fields ?? {}).map((field) => componentName(entity.type, field));

/** The presence change one row's previous→next write implies. */
export interface PresenceDelta {
  readonly rowId: string;
  readonly remove: readonly string[];
  readonly add: readonly string[];
}

/**
 * Derive the delta from two versions of the SAME row: a component present on
 * one side only is added or removed, and a shared component is untouched.
 */
export const presenceDelta = (
  previous: Entity | undefined,
  next: Entity | undefined,
): PresenceDelta => {
  const before = previous === undefined ? [] : componentsOf(previous);
  const after = next === undefined ? [] : componentsOf(next);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    rowId: (next ?? previous)?.id ?? "",
    remove: before.filter((component) => !afterSet.has(component)),
    add: after.filter((component) => !beforeSet.has(component)),
  };
};

/**
 * Apply a delta in place, dropping a component's set once it empties so a
 * component no row carries cannot be read as present with no ids.
 */
export const applyPresenceDelta = (index: PresenceIndex, delta: PresenceDelta): void => {
  for (const component of delta.remove) {
    const ids = index.get(component);
    if (ids === undefined) continue;
    ids.delete(delta.rowId);
    if (ids.size === 0) index.delete(component);
  }
  for (const component of delta.add) {
    const ids = index.get(component);
    if (ids === undefined) index.set(component, new Set([delta.rowId]));
    else ids.add(delta.rowId);
  }
};

/** Ids currently carrying `component`, ascending like every other index read. */
export const presenceIds = (index: PresenceIndex, component: string): readonly string[] =>
  sortSourceIds(index.get(component) ?? []);
