/**
 * TEST HARNESS — not public API, not shipped.
 *
 * `testActions(schema)` builds an actions map mounted on a client, so a test
 * writes through `client.actions.<name>` exactly as application code does.
 * Verbs are addressed by entity name (`{ entity: "todo", id, patch }`) for
 * tests where the write is setup; `run` executes an arbitrary callback over the
 * typed drafts. A test whose subject *is* the write should declare typed
 * actions instead, so it pins the draft surface. The casts that keep call sites
 * clean live here only.
 */

import { defineAction } from "../../schema/action";
import type { ActionDrafts, DuplicateAt, GroupRef } from "../drafts";
import type { PointerValue } from "../query-builder";
import type { ManyPointerValue } from "../relationship";

/** A draft `create` / `duplicate` handle, as seen by a name-addressed verb. */
type LooseHandle = { readonly id: string } & Record<string, unknown>;

/** A system draft namespace (`group` / `membership`): `create` takes the row only. */
interface LooseSystemDraft {
  create(input: Record<string, unknown>): LooseHandle;
}

/** Per-entity draft surface, erased to a name-addressed view. */
interface LooseDraft {
  create(
    input: Record<string, unknown>,
    opts: { groups: readonly GroupRef[] | undefined; validate?: boolean },
  ): LooseHandle;
  update(id: string, patch: Record<string, unknown>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
  duplicate(
    id: string,
    opts?: {
      at?: DuplicateAt;
      groups?: readonly GroupRef[];
      validate?: boolean;
    },
  ): LooseHandle;
  link(id: string, as: string, target: PointerValue): void;
  unlink(id: string, as: string): void;
  setLinks(id: string, as: string, patch: ManyPointerValue): void;
  addToGroup(id: string, groupId: GroupRef): void;
  removeFromGroup(id: string, groupId: GroupRef): void;
  setGroups(id: string, groupIds: readonly GroupRef[]): void;
}

/** The `groupMember` draft namespace: `create` plus the guarded patch/delete pair. */
interface LooseMembershipDraft extends LooseSystemDraft {
  update(id: string, patch: Record<string, unknown>, opts?: { validate?: boolean }): void;
  delete(id: string): void;
}

/** The whole draft surface, keyed by entity name plus the system namespaces. */
type LooseDrafts = Record<string, LooseDraft> & {
  group: LooseSystemDraft;
  membership: LooseMembershipDraft;
};

/** Erase the schema-typed drafts to the name-addressed view. */
const loose = (drafts: unknown): LooseDrafts => drafts as LooseDrafts;

/** The entity's draft namespace; an unknown name is the test's mistake. */
const entityOf = (drafts: LooseDrafts, entity: string): LooseDraft => {
  const namespace = drafts[entity];
  if (namespace === undefined) {
    throw new Error(`testActions: no entity "${entity}" on the schema`);
  }
  return namespace;
};

interface CreateParams {
  readonly entity: string;
  readonly input: Record<string, unknown>;
  readonly groups?: readonly GroupRef[];
  readonly validate?: boolean;
}

interface UpdateParams {
  readonly entity: string;
  readonly id: string;
  readonly patch: Record<string, unknown>;
  readonly validate?: boolean;
}

interface DeleteParams {
  readonly entity: string;
  readonly id: string;
}

interface DuplicateParams {
  readonly entity: string;
  readonly id: string;
  readonly at?: DuplicateAt;
  readonly groups?: readonly GroupRef[];
  readonly validate?: boolean;
}

interface LinkParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly target: PointerValue;
}

interface UnlinkParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
}

interface SetLinksParams {
  readonly entity: string;
  readonly id: string;
  readonly as: string;
  readonly targets: ManyPointerValue;
}

interface GroupVerbParams {
  readonly entity: string;
  readonly id: string;
  readonly group: GroupRef;
}

interface SetGroupsParams {
  readonly entity: string;
  readonly id: string;
  readonly groups: readonly GroupRef[];
}

interface CreateSystemParams {
  readonly input: Record<string, unknown>;
}

interface UpdateMembershipParams {
  readonly id: string;
  readonly patch: Record<string, unknown>;
  readonly validate?: boolean;
}

interface MembershipIdParams {
  readonly id: string;
}

/**
 * One mounted-ready action per draft verb, plus `run`. Every action takes
 * its arguments as a single params object, so a test dispatches a write
 * with one call and no per-test declaration.
 */
export const testActions = <S>(schema: S) => ({
  create: defineAction(schema, (drafts, params: CreateParams) => {
    const { entity, input, groups, validate } = params;
    return entityOf(loose(drafts), entity).create(input, { groups, validate });
  }),
  update: defineAction(schema, (drafts, params: UpdateParams): void => {
    const { entity, id, patch, validate } = params;
    entityOf(loose(drafts), entity).update(id, patch, { validate });
  }),
  delete: defineAction(schema, (drafts, params: DeleteParams): void => {
    entityOf(loose(drafts), params.entity).delete(params.id);
  }),
  duplicate: defineAction(schema, (drafts, params: DuplicateParams) => {
    const { entity, id, at, groups, validate } = params;
    return entityOf(loose(drafts), entity).duplicate(id, { at, groups, validate });
  }),
  link: defineAction(schema, (drafts, params: LinkParams): void => {
    const { entity, id, as, target } = params;
    entityOf(loose(drafts), entity).link(id, as, target);
  }),
  unlink: defineAction(schema, (drafts, params: UnlinkParams): void => {
    entityOf(loose(drafts), params.entity).unlink(params.id, params.as);
  }),
  setLinks: defineAction(schema, (drafts, params: SetLinksParams): void => {
    const { entity, id, as, targets } = params;
    entityOf(loose(drafts), entity).setLinks(id, as, targets);
  }),
  addToGroup: defineAction(schema, (drafts, params: GroupVerbParams): void => {
    const { entity, id, group } = params;
    entityOf(loose(drafts), entity).addToGroup(id, group);
  }),
  removeFromGroup: defineAction(schema, (drafts, params: GroupVerbParams): void => {
    const { entity, id, group } = params;
    entityOf(loose(drafts), entity).removeFromGroup(id, group);
  }),
  setGroups: defineAction(schema, (drafts, params: SetGroupsParams): void => {
    const { entity, id, groups } = params;
    entityOf(loose(drafts), entity).setGroups(id, groups);
  }),
  createGroup: defineAction(schema, (drafts, params: CreateSystemParams) =>
    loose(drafts).group.create(params.input),
  ),
  createMembership: defineAction(schema, (drafts, params: CreateSystemParams) =>
    loose(drafts).membership.create(params.input),
  ),
  updateMembership: defineAction(schema, (drafts, params: UpdateMembershipParams): void => {
    const { id, patch, validate } = params;
    loose(drafts).membership.update(id, patch, { validate });
  }),
  deleteMembership: defineAction(schema, (drafts, params: MembershipIdParams): void => {
    loose(drafts).membership.delete(params.id);
  }),
  // `any` rather than the callback's own type: a definition's Result is
  // fixed when it is declared, while a test callback varies per call.
  run: defineAction(schema, (drafts, build: (drafts: ActionDrafts<S>) => any) =>
    build(drafts as ActionDrafts<S>),
  ),
});
