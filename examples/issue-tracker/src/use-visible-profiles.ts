/**
 * The profiles visible to the signed-in actor. The assignee filter offers
 * exactly these, because a profile is group-scoped and an issue can only be
 * assigned to someone whose profile the actor can read.
 */

import { useQuery } from "./use-ebb";

export function useVisibleProfiles() {
  const { data: profiles = [] } = useQuery((q) => q.profile.query().orderBy("display_name", "asc"));
  return profiles;
}
