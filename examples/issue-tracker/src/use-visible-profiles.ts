/**
 * The profiles visible to the signed-in actor. The assignee filter offers
 * exactly these, because a profile is group-scoped and an issue can only be
 * assigned to someone whose profile the actor can read.
 */

import { useQuery, type QueryRoot } from "@ebbjs/react";
import type { Schema } from "./schema";

export function useVisibleProfiles() {
  const { data: profiles = [] } = useQuery((q: QueryRoot<Schema>) =>
    q.profile.query().orderBy("display_name", "asc"),
  );
  return profiles;
}
