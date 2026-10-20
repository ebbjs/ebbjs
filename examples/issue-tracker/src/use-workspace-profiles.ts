/**
 * The profiles visible inside one workspace group.
 *
 * A profile is group-scoped, so this list is exactly the people the
 * workspace can assign an issue to. `groupId` is `undefined` until the
 * issue that names the group has loaded; the query then matches no
 * rows, and re-runs when the group id arrives.
 */

import { useQuery, type QueryRoot } from "@ebbjs/react";
import type { Schema } from "./schema";

export function useWorkspaceProfiles(groupId: string | undefined) {
  const { data: profiles = [] } = useQuery(
    (q: QueryRoot<Schema>) => q.profile.query().where("groups", groupId),
    [groupId],
  );
  return profiles;
}
