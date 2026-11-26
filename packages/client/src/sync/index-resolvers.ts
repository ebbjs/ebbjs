/**
 * The registry of derived index families (#961, #1003).
 *
 * The relation, existence and scope query families each own both directions
 * of their contract in one module: the indices a query read declares, and the
 * keys a change resolves to under them. The membership index is a row
 * subscription read with no query-side declaration, so it keeps its own
 * module. This module is the single list that composes the declarations into
 * {@link structuralReads} and registers the resolvers
 * {@link createIndexResolvers} hands the dispatcher, so the two cannot drift.
 *
 * Every resolver answers from the row index #971 owns rather than from the
 * changed row's values, and the membership resolver also leans on the change's
 * journal delta: the entity a departed membership row filed is gone from the
 * row. A change's journal entry names the components it touched, not the index
 * keys that moved, so a resolver that cannot prove a key answers `null`: the
 * dispatcher then touches every entry that declared the index, which is exactly
 * the breadth the component read set gave before this narrowing existed. The
 * failure mode is an extra touch, never a miss.
 */

import type { Replica } from "@ebbjs/storage/replica";

import type { IndexResolver } from "./dependency-index";
import { existsIndexFamily } from "./exists-index";
import type { IndexFamily } from "./index-family";
import { MEMBERSHIP_INDEX, membershipResolver } from "./membership-index";
import { relationIndexFamily } from "./relation-index";
import { scopeIndexFamily } from "./scope-index";

export { MEMBERSHIP_INDEX } from "./membership-index";
export { relationIndex } from "./relation-index";

/**
 * The query index families, in declaration order. A new derived index is one
 * family module and one entry here: the read path composes the list, and the
 * resolver registry serves every name the families declare.
 */
export const INDEX_FAMILIES: readonly IndexFamily[] = [
  relationIndexFamily,
  existsIndexFamily,
  scopeIndexFamily,
];

/**
 * The resolvers the subscription registry and the benchmark register. The
 * `membership` resolver serves row subscriptions; each query family answers
 * under the names it declares.
 */
export const createIndexResolvers = (replica: Replica): Readonly<Record<string, IndexResolver>> => {
  const resolvers: Record<string, IndexResolver> = {
    [MEMBERSHIP_INDEX]: membershipResolver(replica),
  };
  for (const family of INDEX_FAMILIES) {
    for (const name of family.names) {
      resolvers[name] = family.resolver(replica);
    }
  }
  return resolvers;
};
