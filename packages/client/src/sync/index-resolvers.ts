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
 * Every journal entry states its whole movement (ADR 0006), so every resolver
 * here answers from the change and its delta alone: a content change names the
 * components it touched, and a link write or membership change reads the
 * journal's `edges`, `existence` or `membership` part. No resolver reads a row
 * back, and none has a "cannot say" branch to answer.
 *
 * A name no resolver here serves is a different failure: nothing can narrow it,
 * ever, so the dispatcher refuses such a declaration at `add` rather than
 * hiding a typo behind a batch that always touches its whole declarer set. A
 * name a namespace here serves is served, whatever follows the prefix.
 */

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
export const createIndexResolvers = (): Readonly<Record<string, IndexResolver>> => {
  const resolvers: Record<string, IndexResolver> = {
    [MEMBERSHIP_INDEX]: membershipResolver,
  };
  for (const family of INDEX_FAMILIES) {
    for (const name of family.names) {
      resolvers[name] = family.resolver();
    }
  }
  return resolvers;
};
