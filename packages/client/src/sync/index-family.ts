/**
 * The shape every query index family implements (#1003).
 *
 * A family owns both directions of one index's contract: the dependencies a
 * read declares under it, and the keys a change resolves to. They must agree
 * — a name only one side knows silently widens dispatch to the component
 * fallback — so both live in the family module rather than one in the planner
 * and one in the resolver registry.
 */

import type { Replica } from "@ebbjs/storage/replica";

import type { IndexDependency, IndexResolver } from "./dependency-index";
import type { Predicate, Query } from "./query";

/** Everything one read declares under one index family. */
export interface IndexDeclaration {
  readonly indices: readonly IndexDependency[];
  /** Components the indices replace as the dispatcher's match key. */
  readonly covered: readonly string[];
  /**
   * The declared indices no component in the read set re-checks, so a retained
   * result has to re-check the key itself before trusting its own result
   * (#1011). A membership predicate's `scope` is the one: it has no component
   * to fall back on. The membership keys a projected result derives from its
   * rows are the same kind of dependency, supplied by the consumer instead, so
   * the scope family is the only one that declares these.
   */
  readonly recheck: readonly IndexDependency[];
}

/**
 * One derived index family. {@link IndexFamily.names} is how the family is
 * registered and later looked up, so declaration and resolution are reachable
 * from one entry in the registry's family list.
 */
export interface IndexFamily {
  /**
   * The registration names this family's resolvers answer to: an exact index
   * name (`scope`), or a namespace (`relation:*`) serving every name it
   * prefixes.
   */
  readonly names: readonly string[];
  /** The index reads one query declares under this family. */
  declare(query: Query): IndexDeclaration;
  /**
   * The resolver this family registers, bound to the replica it answers from.
   * The dispatcher passes the concrete index name per change, so a namespace
   * family answers for the name it was asked about, and a `null` answer makes
   * the dispatcher touch every reader of that index — the breadth the
   * component read set gave before it.
   */
  resolver(replica: Replica): IndexResolver;
}

/** The registration name of the namespace serving every index starting with `prefix`. */
export const namespaceName = (prefix: string): string => `${prefix}*`;

/** Every predicate a read declares, in DNF declaration order. */
export const predicatesOf = (query: Query): readonly Predicate[] => query.groups.flat();

/**
 * Combine one declaration per family into the read's structural indices. One
 * predicate may appear in more than one OR group, and one index may be read by
 * both a predicate and a join; the dispatcher buckets a dependency once, so
 * the repeats are dropped here. A covered component is a value the index
 * replaces, so repeats collapse the same way, and so do the keys of an index
 * the read set cannot re-check.
 */
export const composeDeclarations = (
  declarations: readonly IndexDeclaration[],
): IndexDeclaration => {
  const indices: IndexDependency[] = [];
  const recheck: IndexDependency[] = [];
  const seen = new Set<string>();
  const recheckSeen = new Set<string>();
  const covered: string[] = [];
  for (const declaration of declarations) {
    for (const { index, key } of declaration.indices) {
      const name = `${index}\u0000${key}`;
      if (seen.has(name)) continue;
      seen.add(name);
      indices.push({ index, key });
    }
    // A rechecked index is also a dispatch key, so it is deduped apart from
    // one: the same dependency is declared once in each list.
    for (const dependency of declaration.recheck) {
      const name = `${dependency.index}\u0000${dependency.key}`;
      if (recheckSeen.has(name)) continue;
      recheckSeen.add(name);
      recheck.push(dependency);
    }
    covered.push(...declaration.covered);
  }
  return { indices, covered: [...new Set(covered)], recheck };
};
