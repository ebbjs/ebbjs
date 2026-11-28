/**
 * The `exists:<component>` index family (#961, #1003).
 *
 * An existence predicate reads whether one component is present, so the index
 * is keyed by that component. A change can move that answer by writing the
 * component, by carrying an existence delta for it, or by a row arriving or
 * leaving, so every change shape is answered from what it carries.
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
 * Every existence index keys on the component it tests, so a change names it
 * through the component set it touched — presence changes included — or, for a
 * membership change, through the journal's existence delta. The delta is
 * complete (ADR 0006), so a part naming nothing moved no existence at all and
 * the component stayed. Membership of the component's model is carried by the
 * read's `sources` as well, which is what keeps a new row's arrival touching
 * the read.
 */
const existsSubjects = (change: ReplicaChange, index: string): readonly string[] => {
  const touched =
    change.kind === "content"
      ? change.components
      : [...change.delta.existence.added, ...change.delta.existence.removed];
  const component = existsComponent(index);
  // A name this family cannot parse is one a consumer supplied by hand: every
  // component the change named is the answer, since any could be the one it
  // tests. Validating the component against the schema is #1028.
  if (component === null) return [...new Set(touched)];
  return touched.includes(component) ? [component] : [];
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
