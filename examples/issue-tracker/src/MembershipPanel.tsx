/**
 * Workspace membership controls for the shared workspace.
 *
 * Membership is the reserved `groupMember` store; this panel reads the
 * actor's own row out of it to decide what to show. Joining is two writes
 * by two actors (#623): the workspace's service actor (`demo-seeder`)
 * invites — groups are closed by default (#126) — and then this actor's
 * own client shares its profile, which is the only client allowed to.
 * Leaving is self-service.
 *
 * The refresh between the writes is what makes the share legal: the
 * invitee's client has to observe the membership (and the permissions it
 * grants in the group) before it can file the profile into it. The
 * intermediate state — member, no profile — is `profile-pending`, and it
 * is real for an actor invited while away.
 */

import { useEffect, useState } from "react";
import { useClient, useQuery, type QueryRoot } from "@ebbjs/react";
import type { BootstrapResult } from "./bootstrap";
import type { Schema } from "./schema";
import { MEMBER_PERMISSIONS, SHARED_GROUP_ID } from "./seed";
import { useWrite } from "./use-write";
import { inviteToWorkspace, leaveWorkspace, shareProfileToWorkspace } from "./workspace";

export function MembershipPanel({
  actorId,
  bootstrap,
}: {
  actorId: string;
  bootstrap: BootstrapResult;
}) {
  const client = useClient<Schema>();
  const { data: members = [] } = useQuery(
    (q: QueryRoot<Schema>) =>
      q.membership.query().where("group_id", SHARED_GROUP_ID).where("actor_id", actorId),
    [actorId],
  );
  const membership = members[0];
  const { pending: busy, error, run } = useWrite();
  const [deniedFor, setDeniedFor] = useState<string | null>(null);

  useEffect(() => {
    if (membership === undefined) {
      setDeniedFor(null);
      return;
    }
    // `unknown` is not a denial — the server stays the authority, so the
    // control stays enabled and a refusal surfaces as an error. The answer is
    // recorded against this membership's id, so a late result for a previous
    // row cannot decide the current control.
    void client.can(membership, "delete").then((result) => {
      if (result.kind === "denied") setDeniedFor(membership.id);
    });
  }, [client, membership]);

  const leaveDenied = membership !== undefined && deniedFor === membership.id;

  const join = (): void => {
    void run(async () => {
      await inviteToWorkspace({
        inviter: bootstrap.seeder,
        actorId,
        groupId: SHARED_GROUP_ID,
        permissions: MEMBER_PERMISSIONS,
      });
      await bootstrap.refresh();
      await shareProfileToWorkspace({ client, actorId, groupId: SHARED_GROUP_ID });
      await bootstrap.refresh();
    });
  };

  const leave = (): void => {
    void run(async () => {
      await leaveWorkspace({ client, actorId, groupId: SHARED_GROUP_ID });
      await bootstrap.refresh();
    });
  };

  return (
    <section className="rounded border border-stone-800 p-4">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-stone-500">membership</h2>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-stone-300">Shared Workspace</span>
        {membership === undefined ? (
          <button
            type="button"
            onClick={join}
            disabled={busy}
            className="rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500 disabled:opacity-50"
          >
            join
          </button>
        ) : (
          <button
            type="button"
            onClick={leave}
            disabled={busy || leaveDenied}
            title={leaveDenied ? "the client would not be allowed to leave" : undefined}
            className="rounded border border-stone-600 px-2 py-0.5 font-mono text-xs text-stone-300 hover:border-stone-400 disabled:opacity-50"
          >
            leave
          </button>
        )}
        {membership !== undefined && (
          <span className="font-mono text-xs text-emerald-400" data-testid="membership-state">
            member
          </span>
        )}
      </div>
      {error !== null && <p className="mt-2 font-mono text-xs text-red-400">{error}</p>}
    </section>
  );
}
