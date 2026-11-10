import { componentName, type Entity } from "@ebbjs/core";

import { sortSourceIds } from "./reverse-index";

/**
 * Component existence over the composed view: which components
 * (`<type>/<field>`) each materialized row currently carries.
 *
 * A row's component set is the set of keys in `data.fields` — one row has one
 * model, so each present field names exactly one component. A dropped
 * component is a missing key, which is what makes existence a fact about the
 * row rather than a value stored in it.
 *
 * In memory only: the replica rebuilds it from the rows on load, like the
 * adjacency indices, and #799 owns the durable index that replaces it.
 */

/** Component name → ids currently carrying it. Immutable by convention. */
export type ComponentIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** The component names a row carries, one per present field of its type. */
export const componentsOf = (entity: Entity): readonly string[] =>
  Object.keys(entity.data?.fields ?? {}).map((field) => componentName(entity.type, field));

/** The existence change one row's previous→next write implies. */
export interface ComponentDelta {
  readonly rowId: string;
  readonly remove: readonly string[];
  readonly add: readonly string[];
}

/**
 * Derive the delta from two versions of the SAME row: a component present on
 * one side only is added or removed, and a shared component is untouched.
 * Both sides undefined means nothing changed, so there is no delta.
 */
export const componentDelta = (
  previous: Entity | undefined,
  next: Entity | undefined,
): ComponentDelta | null => {
  if (previous === next) return null;
  if (previous === undefined && next === undefined) return null;
  const before = previous === undefined ? [] : componentsOf(previous);
  const after = next === undefined ? [] : componentsOf(next);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    rowId: (next ?? previous)!.id,
    remove: before.filter((component) => !afterSet.has(component)),
    add: after.filter((component) => !beforeSet.has(component)),
  };
};

/**
 * Apply a delta, returning a new index. The whole index is copied, as the
 * adjacency deltas copy theirs, and a component's set is dropped once it
 * empties so a component no row carries cannot be read as present with no ids.
 */
export const applyComponentDelta = (
  index: ComponentIndex,
  delta: ComponentDelta,
): ComponentIndex => {
  if (delta.add.length === 0 && delta.remove.length === 0) return index;
  const next = new Map(index);
  for (const component of delta.remove) {
    const ids = next.get(component);
    if (ids === undefined) continue;
    const remaining = new Set(ids);
    remaining.delete(delta.rowId);
    if (remaining.size === 0) next.delete(component);
    else next.set(component, remaining);
  }
  for (const component of delta.add) {
    next.set(component, new Set([...(next.get(component) ?? []), delta.rowId]));
  }
  return next;
};

/** Build the index for a whole row set in one linear pass (a record load). */
export const buildComponentIndex = (entities: Iterable<Entity>): ComponentIndex => {
  const index = new Map<string, Set<string>>();
  for (const entity of entities) {
    for (const component of componentsOf(entity)) {
      const ids = index.get(component);
      if (ids === undefined) index.set(component, new Set([entity.id]));
      else ids.add(entity.id);
    }
  }
  return index;
};

/** Ids currently carrying `component`, ascending like every other index read. */
export const componentIds = (index: ComponentIndex, component: string): readonly string[] =>
  sortSourceIds(index.get(component) ?? []);
