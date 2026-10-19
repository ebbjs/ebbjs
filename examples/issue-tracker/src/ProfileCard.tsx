/**
 * The signed-in actor's profile, read from the group-scoped `profile`
 * collection. The row is visible only inside workspaces the actor has
 * joined — proof that profile visibility follows group membership.
 */

import { useQuery, type QueryRoot } from "@ebbjs/react";
import type { Schema } from "./schema";

export function ProfileCard({ actorId }: { actorId: string }) {
  const { data: profiles = [], loading } = useQuery((q: QueryRoot<Schema>) => q.profile.query());
  const mine = profiles.find((row) => row.actor_id === actorId);

  return (
    <section className="rounded border border-stone-800 p-4">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-stone-500">profile</h2>
      {loading ? (
        <p className="font-mono text-xs text-stone-500">loading…</p>
      ) : mine === undefined ? (
        <p className="font-mono text-xs text-stone-500">
          no profile visible for <span className="text-stone-300">{actorId}</span>
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-800 font-mono text-sm text-stone-300">
            {mine.display_name.slice(0, 1).toUpperCase()}
          </div>
          <div className="font-mono text-xs">
            <div className="text-stone-200">{mine.display_name}</div>
            <div className="text-stone-500">{mine.actor_id}</div>
          </div>
        </div>
      )}
    </section>
  );
}
