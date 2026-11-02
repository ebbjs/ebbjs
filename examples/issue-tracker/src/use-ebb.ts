/**
 * The app's hooks, bound to its client type once.
 *
 * React context erases types, so `useClient` has to be told the client type
 * and `useQuery` cannot take a schema as a type argument (TypeScript does not
 * partially infer type arguments, so the rows would lose their fields).
 * Binding both here means components write plain hooks: `useEbb()` returns the
 * app's client and `useQuery((q) => …)` types `q` for them.
 */

import { createEbbHooks, type QueryRootOf } from "@ebbjs/react";
import type { IssueTrackerClient } from "./bootstrap";

export const { useClient: useEbb, useQuery } = createEbbHooks<IssueTrackerClient>();

/** What a query builder sees: the client's namespaces, read-only. */
export type IssueReadRoot = QueryRootOf<IssueTrackerClient>;
