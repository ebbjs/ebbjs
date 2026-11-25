/**
 * The derived-index names a query read declares and the keys a change resolves
 * to under them (#961).
 *
 * One module owns both directions because they must agree: a query lowers its
 * predicates and joins to {@link IndexDependency} keys, and the registry's
 * resolvers turn a change back into the keys it may have moved. A name that
 * only one side knew would silently widen dispatch to the component fallback,
 * so the encoders live here rather than as string literals in two modules.
 *
 * Every resolver answers from the row index #971 owns rather than from the
 * changed row's values. A change's journal entry names the components it
 * touched, not the index keys that moved, so a resolver that cannot prove a
 * key answers `null`: the dispatcher then touches every entry that declared
 * the index, which is exactly the breadth the component read set gave before
 * this narrowing existed. The failure mode is an extra touch, never a miss.
 */

import { EBB_COMPONENTS, systemValueString, type Entity } from "@ebbjs/core";
import type { Replica, ReplicaChange } from "@ebbjs/storage/replica";

import type { IndexDependency, IndexResolver } from "./dependency-index";

/** Row subscriptions: the member entity id a membership row files. */
export const MEMBERSHIP_INDEX = "membership";

/** Scope-aware reads: one dependency per group id whose membership the read follows. */
export const SCOPE_INDEX = "scope";

const RELATION_PREFIX = "relation:";
const EXISTS_PREFIX = "exists:";

/** A resolver registered under this key serves every `relation:` index name. */
const RELATION_RESOLVER = `${RELATION_PREFIX}*`;

/** A resolver registered under this key serves every `exists:` index name. */
const EXISTS_RESOLVER = `${EXISTS_PREFIX}*`;

/** `relation:<as>/<type>`, keyed by the target row id a read cares about. */
export const relationIndex = (as: string, type: string): string =>
  `${RELATION_PREFIX}${as}/${type}`;

/** `exists:<component>`, keyed by the component whose presence a read tests. */
export const existsIndex = (component: string): string => `${EXISTS_PREFIX}${component}`;

/** The component an existence index name encodes, or `null` for another name. */
const existsComponent = (index: string): string | null => {
  if (!index.startsWith(EXISTS_PREFIX)) return null;
  const component = index.slice(EXISTS_PREFIX.length);
  return component.length === 0 ? null : component;
};

/** The dependency a relationship predicate or join adds for one target. */
export const relationDependency = (
  as: string,
  type: string,
  targetId: string,
): IndexDependency => ({ index: relationIndex(as, type), key: targetId });

/** The dependency an existence predicate adds for its component. */
export const existsDependency = (component: string): IndexDependency => ({
  index: existsIndex(component),
  key: component,
});

/** The dependency a scope-aware read adds for one group. */
export const scopeDependency = (groupId: string): IndexDependency => ({
  index: SCOPE_INDEX,
  key: groupId,
});

/** The group a changed row is filed under, read from its `ebb/membership` value. */
const membershipGroupId = (row: Entity): string | null =>
  systemValueString(row, "membership", "group_id");

/**
 * The member entity a membership row files, or `null` when the changed row is
 * not a membership row this index answers for.
 */
const membershipSubject = (replica: Replica, change: ReplicaChange): string | null => {
  // A membership row files a different row than the one it is, so the member
  // is only reachable by reading the changed row — once per change, not once
  // per subscription. A membership row arriving or leaving is a membership
  // change that names no component, so the row itself says what it files.
  if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
    return null;
  }
  const changed = replica.get(change.id);
  if (changed === undefined) return null;
  const id = systemValueString(changed, "membership", "entity_id");
  return id !== null && id.length > 0 ? id : null;
};

/**
 * A link write never names the targets it *dropped*: the journal carries the
 * components a write touched, and the row index holds only the edges that
 * exist after it. A read keyed on a removed target would therefore be missed
 * if the resolver guessed, so a link write answers `null` and dispatch falls
 * back to every reader of the relation — the breadth the `ebb/link` component
 * dependency had before this index existed.
 *
 * Every other change is precise. A membership change names the row, so a read
 * that joins it as a target follows it; a read that sources the relation from
 * that row follows the read's own `sources` model set. A content change to a
 * row is that row's id, which is the key of any read that follows it as a
 * joined target.
 */
const relationSubjects = (change: ReplicaChange): readonly string[] | null =>
  change.kind === "content" && change.components.includes(EBB_COMPONENTS.link) ? null : [change.id];

/**
 * The group whose membership a change moved. An entering or refiled row names
 * its current group, so a scoped read of another group is left alone. A row
 * that left, or a membership value write, may have left a group the journal
 * does not name — and an evicted row is gone — so those answer `null` and
 * dispatch falls back to every scoped read.
 */
const scopeSubjects =
  (replica: Replica): IndexResolver =>
  (change) => {
    if (change.kind === "content" && !change.components.includes(EBB_COMPONENTS.membership)) {
      return [];
    }
    if (change.kind === "content") return null;
    const changed = replica.get(change.id);
    if (changed === undefined) return null;
    const groupId = membershipGroupId(changed);
    if (groupId === null || groupId.length === 0) {
      return change.membership === "left" ? null : [];
    }
    return [groupId];
  };

/**
 * The resolvers the subscription registry and the benchmark register. The
 * `membership` resolver serves row subscriptions; the two namespace keys serve
 * every `relation:` and `exists:` name a query read declares, and `scope`
 * serves scope-aware reads.
 */
export const createIndexResolvers = (
  replica: Replica,
): Readonly<Record<string, IndexResolver>> => ({
  [MEMBERSHIP_INDEX]: (change) => {
    const subject = membershipSubject(replica, change);
    return subject === null ? [] : [subject];
  },
  [SCOPE_INDEX]: scopeSubjects(replica),
  [RELATION_RESOLVER]: relationSubjects,
  // Every existence index keys on the component it tests, so the resolver
  // reads the component out of the index name and answers a content change
  // that names it. Membership of the component's model is carried by the
  // read's `sources`, not by this index.
  [EXISTS_RESOLVER]: (change, index) => {
    const component = existsComponent(index);
    if (component === null || change.kind !== "content") return [];
    return change.components.includes(component) ? [component] : [];
  },
});
