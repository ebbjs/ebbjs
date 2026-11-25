/**
 * The `exists:<component>` index family (#961, #1003).
 *
 * An existence predicate reads whether one component is present, so the index
 * is keyed by that component and a content change that names it is the only
 * change that can move the answer.
 */

import type { ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexDependency } from "./dependency-index";
import { namespaceName, predicatesOf, type IndexFamily } from "./index-family";

const EXISTS_PREFIX = "exists:";

/** The registration name serving every `exists:` index. */
const EXISTS_NAMESPACE = namespaceName(EXISTS_PREFIX);

/** `exists:<component>`, keyed by the component whose presence a read tests. */
const existsIndex = (component: string): string => `${EXISTS_PREFIX}${component}`;

/** The component an existence index name encodes, or `null` for another name. */
const existsComponent = (index: string): string | null => {
  if (!index.startsWith(EXISTS_PREFIX)) return null;
  const component = index.slice(EXISTS_PREFIX.length);
  return component.length === 0 ? null : component;
};

/** The dependency an existence predicate adds for its component. */
const existsDependency = (component: string): IndexDependency => ({
  index: existsIndex(component),
  key: component,
});

/**
 * Every existence index keys on the component it tests, so the resolver reads
 * the component out of the index name and answers a content change that names
 * it. Membership of the component's model is carried by the read's `sources`,
 * not by this index.
 */
const existsSubjects = (change: ReplicaChange, index: string): readonly string[] | null => {
  const component = existsComponent(index);
  if (component === null || change.kind !== "content") return [];
  return change.components.includes(component) ? [component] : [];
};

export const existsIndexFamily: IndexFamily = {
  names: [EXISTS_NAMESPACE],
  declare: (query) => {
    const indices: IndexDependency[] = [];
    const covered: string[] = [];
    for (const predicate of predicatesOf(query)) {
      if (predicate.kind !== "existence") continue;
      indices.push(existsDependency(predicate.component));
      covered.push(predicate.component);
    }
    return { indices, covered };
  },
  resolver: () => existsSubjects,
};
