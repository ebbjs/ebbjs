---
title: "Permission Enforcement"
description: "How permissions are checked on client and server."
---

Permissions are checked in two places: on the client (before writing to the Outbox) and on the server (before accepting [Actions](/docs/data-model)). Both run the same logic against the same data model, so they should agree — unless the client's view is stale.

## How permission checks work

When an Actor submits an Action, Ebb checks each Update within it: "Does this Actor have permission to perform this operation on this Entity?"

The check follows this logic:

1. **Find the Entity's Groups** — Look up all [Relationships](/docs/relationships) where the Entity is the source and the target is a [Group](/docs/groups).

2. **Find the Actor's memberships** — Look up all GroupMember Entities for this Actor that reference any of those Groups.

3. **Check permissions** — For each GroupMember, check if its `permissions` array includes the required permission (`<type>.<action>`) or `*`.

4. **Any match wins** — If _any_ GroupMember grants the permission, the operation is allowed. This is a permissive model.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Permission Check Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Actor wants to: update Post(id=p-123)                                     │
│                                                                             │
│   Step 1: Find Entity's Groups                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  Relationships where source=p-123 AND target.type=Group              │  │
│   │                                                                      │  │
│   │  Post(p-123) ──belongs_to──► Group(g-work)                           │  │
│   │              ──belongs_to──► Group(g-shared)                         │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 2: Find Actor's memberships in those Groups                          │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  GroupMember records for Actor in [g-work, g-shared]                 │  │
│   │                                                                      │  │
│   │  Actor ──member──► g-work   { permissions: ["post.update", "..."] }  │  │
│   │        ──member──► g-shared { permissions: ["post.read"] }           │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 3: Check for required permission (post.update)                       │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  g-work membership:   ["post.update", ...] ── contains "post.update" │  │
│   │  g-shared membership: ["post.read"]        ── does NOT contain       │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│   Step 4: Any match wins ──► ALLOWED (via g-work membership)                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Permission types by action

| Action                   | Required permission                        | Notes                                                                    |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| Read an Entity           | (implicit)                                 | GroupMembers can read all Entities in their Groups                       |
| Create an Entity         | `<type>.create` in target Group(s)         | Checked against the Group(s) the Entity will belong to                   |
| Update an Entity         | `<type>.update` in any Group               | Entity must belong to at least one Group where Actor has this permission |
| Delete an Entity         | `<type>.delete` in any Group               | Same as update                                                           |
| Add Entity to Group      | `<type>.create` in target Group            | You're effectively "creating" the Entity's presence in that Group        |
| Remove Entity from Group | `<type>.update` in source Entity's Groups  | Treated as modifying the Entity's membership                             |
| Create Relationship      | `<type>.update` on source Entity           | Default; can be overridden per relationship type                         |
| Modify GroupMember       | `groupMember.update` (or `*`) in the Group | Changing someone's permissions requires permission in that Group         |
| Remove GroupMember       | `groupMember.delete` (or `*`) in the Group | Removing someone from a Group requires permission in that Group          |

## Client-side validation

The client checks permissions before writing to the Outbox. Since the client has synced GroupMember records for its Actor, it can run the same permission logic locally.

This provides immediate feedback — the user knows right away if an Action isn't allowed, without a round-trip to the server.

If the client's permission data is stale (e.g., permissions were revoked while offline), the client may optimistically allow an Action that the server will reject. This is handled through the normal [Outbox error flow](/docs/sync#client-to-server-writes) — the Action is marked with an error, and the application decides how to surface it.

## Server-side validation

The server is the authority. It validates every incoming Action against the current permission state before accepting it. Each Update within the Action is checked individually, but the Action succeeds or fails as a whole.

If validation fails, the entire Action is rejected. The server returns enough information for the client to understand _which_ Update failed and _why_, so the application can handle it appropriately.
