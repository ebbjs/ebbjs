/**
 * The issue-tracker's typed data model, built from the public
 * `@ebbjs/client` surface only.
 *
 * Field names are pinned here and reused by every later slice (#439–#445).
 *
 * Membership is ebb's built-in system (`group`, `groupMember`,
 * `entityGroup`) — no user-defined `member` entity. A row's group comes
 * from the built-in `groups` join, not a `group_id` field: `workspace`
 * deliberately carries no `group_id`.
 *
 * The assignee is an entity link, not a scalar. `assignee_id` would be a
 * denormalized reference the engine cannot keep consistent;
 * `defineRelationship` gives the `assignee` join,
 * `.where("assignee", profileId)`, and the `link` / `unlink` write path.
 * See #441 for the membership side.
 */

import { defineEntity, defineRelationship, defineSchema, e } from "@ebbjs/client";

export const workspace = defineEntity("workspace", {
  name: e.string(),
  slug: e.string(),
  description: e.string(),
});

export const profile = defineEntity("profile", {
  actor_id: e.string(),
  display_name: e.string(),
  avatar_url: e.string(),
});

export const issue = defineEntity("issue", {
  title: e.string(),
  status: e.string(),
  priority: e.string(),
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
  entities: { workspace, profile, issue },
  relationships: { issueAssignee },
  version: 2,
});

export type Schema = typeof schema;
