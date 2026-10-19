/**
 * Workspace membership controls for the shared workspace.
 *
 * Membership is the reserved `groupMember` store; this panel reads the
 * actor's own row out of it to decide what to show. Joining is an invite
 * run by the shared workspace's service actor (`demo-seeder`) because
 * groups are closed by default (#126); leaving is self-service.
 *
 * Either way the actor's client re-handshakes and re-subscribes through
 * `bootstrap.refresh()`, so the workspace's entities arrive without a
 * reload.
 */

import { useCallback, useEffect, useState } from "react";
import { useClient, useQuery, type QueryRoot } from "@ebbjs/react";
import type { BootstrapResult } from "./bootstrap";
import type { Schema } from "./schema";
import { SEED_PERMISSIONS, SHARED_GROUP_ID } from "./seed";
import { inviteToWorkspace, leaveWorkspace } from "./workspace";

export function MembershipPanel({
  actorId,
  bootstrap,
}: {
  actorId: string;
  bootstrap: BootstrapResult;
}) {
  const client = useClient<Schema>();
  const { data: members = [] } = useQuery((q: QueryRoot<Schema>) => q.membership.query());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deniedFor, setDeniedFor] = useState<string | null>(null);

  const membership = members.find(
    (member) => member.actor_id === actorId && member.group_id === SHARED_GROUP_ID,
  );

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

  const applyMembershipChange = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await bootstrap.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [bootstrap],
  );

  const join = useCallback(
    () =>
      applyMembershipChange(async () => {
        await inviteToWorkspace({
          inviter: bootstrap.seeder,
          actorId,
          groupId: SHARED_GROUP_ID,
          permissions: SEED_PERMISSIONS,
        });
      }),
    [applyMembershipChange, bootstrap, actorId],
  );

  const leave = useCallback(
    () =>
      applyMembershipChange(async () => {
        await leaveWorkspace({ client: bootstrap.client, actorId, groupId: SHARED_GROUP_ID });
      }),
    [applyMembershipChange, bootstrap, actorId],
  );

  return (
    <section className="rounded border border-stone-800 p-4">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-stone-500">membership</h2>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-stone-300">Shared Workspace</span>
        {membership === undefined ? (
          <button
            type="button"
            onClick={() => void join()}
            disabled={busy}
            className="rounded border border-emerald-700 px-2 py-0.5 font-mono text-xs text-emerald-300 hover:border-emerald-500 disabled:opacity-50"
          >
            join
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void leave()}
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
