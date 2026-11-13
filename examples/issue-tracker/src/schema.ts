/**
 * The issue-tracker's typed data model, built from the public
 * `@ebbjs/client` surface only.
 *
 * Field names are pinned here and reused by every later slice (#439–#445).
 *
 * Membership is ebb's built-in platform model, `ebb` — no user-defined
 * `member` entity. Its rows carry one of the four `ebb/*` components:
 * `ebb/group` (`{name, apps}`), `ebb/grant` (`{actor_id, group_id,
 * permissions}`), `ebb/membership` (`{entity_id, group_id}`) and the
 * app-level `ebb/link` edge (`{source_id, target_id, type, field}`). A
 * row's group comes from the built-in `groups` join, not a `group_id`
 * field: `workspace` deliberately carries no `group_id`.
 *
 * The assignee is an entity link, not a scalar. `assignee_id` would be a
 * denormalized reference the engine cannot keep consistent;
 * `defineRelationship` gives the `assignee` join and
 * `.where("assignee", profileId)`, and the demo writes it through the
 * `createIssue` / `setIssueAssignee` Actions (`./actions`). On the wire
 * the join is an `ebb/link` row. See #441 for the membership side.
 */

import { defineModel, defineRelationship, defineSchema, e } from "@ebbjs/client";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "./issue-options";

export const workspace = defineModel("workspace", {
  name: e.string(),
  slug: e.string(),
  description: e.string(),
});

export const profile = defineModel("profile", {
  actor_id: e.string(),
  // A profile is always rendered; empty is the honest absence for the two
  // presentation fields.
  display_name: e.string().default(""),
  avatar_url: e.string().default(""),
});

export const issue = defineModel("issue", {
  title: e.string(),
  // The board groups on status and every card prints a priority, so absence
  // would scatter a row: both declare the value the UI shows when unset.
  status: e.string().default(ISSUE_STATUSES[0]),
  priority: e.string().default(ISSUE_PRIORITIES[1]),
});

/**
 * The issue's assignee is an entity link to an actor's `profile`, not a
 * scalar id. A profile is group-scoped, so an issue can only be assigned
 * to a profile visible in the issue's workspace group — that is, to a
 * workspace member.
 */
export const issueAssignee = defineRelationship({
  source: issue,
  target: profile,
  as: "assignee",
  sourceCardinality: "one",
});

export const schema = defineSchema({
  models: { workspace, profile, issue },
  relationships: { issueAssignee },
  version: 2,
});

export type Schema = typeof schema;
