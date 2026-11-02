/**
 * The demo's client, typed once.
 *
 * Every provider in the tree is given the same client, so components read
 * it through this hook instead of restating the schema and the action map
 * at each call site. The type is the one `bootstrap` builds.
 */

import { useClient } from "@ebbjs/react";
import type { IssueTrackerClient } from "./bootstrap";

export const useAppClient = (): IssueTrackerClient => useClient<IssueTrackerClient>();
