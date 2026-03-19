---
title: "Groups, Membership & Actors"
description: "Permission boundaries, identity, and access control primitives."
---

## Groups and membership

To manage permissions and sync boundaries, Ebb provides built-in Entity types: `Group`, `GroupMember`, and a special interpretation of [Relationships](/docs/relationships).

These aren't special primitives — they're just Entities with a predefined schema that Ebb understands. They flow through the same sync mechanism, materialize the same way, and follow the same conflict resolution rules as your application Entities. The only difference is that Ebb uses them internally to enforce [permissions](/docs/permissions) and determine sync boundaries.

**Two ways to relate to a Group:** Actors _join_ Groups (via `GroupMember` Entities), and Entities _belong to_ Groups (via Relationships). These are different mechanisms with different rules—don't confuse them. Actor membership controls _who_ can access data; Entity membership controls _what data_ lives in a Group.

**Entity membership** is modeled as a Relationship where the target is a Group. Every Entity must belong to at least one Group—this is enforced at both creation and deletion time. When you create an Entity, you must also create its Group membership Relationship in the same [Action](/docs/data-model). And you cannot remove an Entity's last Group membership—if you want the Entity gone, delete the Entity itself.

When Ebb sees a Relationship pointing to a Group, it interprets that as "this Entity is a member of this Group" — which has implications for sync boundaries and permissions.

**Membership permissions:** Unlike regular Relationships, Group membership has a fixed permission rule. To add an Entity to a Group, you need `<type>.create` permission in the **target** Group. This makes sense because you're saying "this Entity should be visible and governed by this Group."

`GroupMember` is a junction Entity between an `Actor` and a `Group`. GroupMembers are implicitly granted read access to all Entities in the Group, but they are explicitly provided write permissions for both Entities and the Group itself through their `permissions` field.

The `permissions` field is an array of strings with the format `<type>.<action>` where `type` is the type of the Entity and `action` is `create`, `update`, or `delete`. To grant full write permissions to a GroupMember, you can simply put `*` in their `permissions` array.

### Membership management

Adding someone to a Group requires creating a GroupMember—which means you need `groupMember.create` permission in that Group. But to have that permission, you must already be a member. This is intentional: Groups are closed by default, and only existing members can invite new ones.

This means invite flows (links, codes, approval requests) are something you build on top of Ebb's primitives. A common pattern is to use a **service account**—an Actor representing your server or a background process—that holds `groupMember.create` permission across many Groups. Your application handles the invite logic (validating links, checking approvals, etc.), and the service account creates the GroupMember once the request is approved.

Ebb provides the access control primitives; the invite _policy_ is up to you.

### Deleting Groups

A Group cannot be deleted while it still contains Entities or GroupMembers. Attempting to delete a non-empty Group will fail. This is intentional—it forces you to explicitly decide what happens to the Entities (move them to another Group, delete them individually, etc.) and remove all members before the Group can be deleted.

This also avoids the ambiguity of Entities that belong to multiple Groups. If cascade deletion were automatic, deleting one Group could destroy data that's still accessible through another Group—a surprising and potentially dangerous behavior.

### Online-only operations

Mutations to Groups and GroupMembers require connectivity—they cannot be performed offline. This includes creating, updating, or deleting Groups, as well as adding, modifying, or removing GroupMembers.

This constraint exists because these entities are structural—they define who can sync what. Allowing these changes offline could create inconsistent states that are difficult to resolve—for example, a user removed from a Group continuing to sync until the change propagates, or a Group deleted on one node while others are still writing to it.

Changing which Groups an _Entity_ belongs to (adding or removing Group membership Relationships) works offline like any other Entity operation. These changes affect what data syncs to whom, but they flow through the normal [sync](/docs/sync) mechanism and converge like any other update.

In practice, the online-only constraint is rarely limiting. Group and GroupMember changes are infrequent compared to regular Entity operations.

## Actors

**Actors** are Ebb's identity abstraction. An Actor might represent a user, but it could also be a server process, an AI agent, a CRON job, or any other system that needs to read or write data.

To integrate your authentication system with Ebb, you implement an `authenticate` callback on the server. This callback receives the incoming request and returns an `actor_id`—typically a user ID from your auth system, but it could be any stable identifier. Ebb handles the rest: if an Actor with that ID already exists, it proceeds; if not, it creates one automatically.

Actors exist outside the sync mechanism. They're the starting point that lets a client bootstrap into the system: authenticate → get Actor ID → query for GroupMember records → now you know what you can sync.

A newly created Actor has no GroupMember relationships—they start completely isolated with no access to any data. From there, they can either create a new Group (which automatically makes them a GroupMember with full permissions) or be added to an existing Group by someone who has permission to do so.

And _that's it_. That's the entire data model of an Ebb app.

**A note on what gets synced:** The sync stream includes _all_ Entities — not just your application Entities, but also Groups, GroupMembers, Relationships, and any other system Entities. When a client syncs, it receives the GroupMember records for _all_ members of the Groups it belongs to—not just its own. This is how the client knows what it's allowed to do locally, and how it can display information about other members of the same Groups.

**Actors don't sync, but Profiles can:** Since Actors exist outside the sync mechanism, a client only sees other members as `actor_id` references on GroupMember records. If your application needs to display member names, avatars, or other profile data, model a `Profile` as a regular application Entity that belongs to the same Groups as the Actor's GroupMembers. Since GroupMember mutations are online-only, maintaining this—adding a Profile's Group membership whenever a GroupMember is created, removing it when one is deleted—can be handled in the same online context without offline coordination concerns.
