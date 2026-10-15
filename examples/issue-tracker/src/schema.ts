/**
 * The issue-tracker's typed data model, built from the public
 * `@ebbjs/client` surface only.
 *
 * Field names are pinned here and reused by every later slice (#439–#445).
 *
 * Membership is ebb's built-in system (`group`, `groupMember`,
 * `entityGroup`) — no user-defined `member` entity. A row's group comes
 * from the built-in `groups` accessor, not a `group_id` field:
 * `workspace` deliberately carries no `group_id`.
 */

import { defineEntity, defineSchema, e } from "@ebbjs/client";

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
  assignee_id: e.string().nullable(),
});

export const schema = defineSchema({
  entities: { workspace, profile, issue },
  version: 1,
});

export type Schema = typeof schema;
