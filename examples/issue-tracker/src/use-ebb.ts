/**
 * The app's hooks, bound to its client type once: components call `useEbb()`
 * and `useQuery((q) => …)` with no generic and no annotation.
 */

import { createEbbHooks, type QueryRootOf } from "@ebbjs/react";
import type { IssueTrackerClient } from "./bootstrap";

export const { useClient: useEbb, useQuery } = createEbbHooks<IssueTrackerClient>();

/** What a query builder sees: the client's namespaces, read-only. */
export type IssueReadRoot = QueryRootOf<IssueTrackerClient>;
