---
"@ebbjs/schema": minor
"@ebbjs/core": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
---

App scope: a group can declare which apps pull it into their replica.

`group.apps` is a per-key-merging map from app id to boolean. A group is in
scope for an app iff its entry is `true`; an absent field (or `null`) means
unscoped, so every app keeps seeing it. Scope is a **sync/residency filter, not
an authorization boundary** — the actor's group grants remain the only
boundary.

```ts
const notes = createClient({ serverUrl, actorId, appId: "notes" });
const { groups } = await notes.handshake(); // only groups scoped to "notes"
```

- `createClient({ appId })` is a local label; it is never sent as a header or
  token and grants nothing.
- `client.seed()` scopes every seeded group without an explicit `apps` map to
  the client's app, and `group.create` writes the same scope on the bootstrap
  put. Later edits are single-key patches (`apps.docs = false`), which the
  wire's per-key merge handles per app id. A seed is a put, so re-seeding a
  group replaces its scope map rather than merging it.
- `handshake()` drops out-of-scope groups and reconciles an active
  subscription: a group whose scope stops naming the app is evicted and the
  live stream reopens without it. Newly in-scope groups are not auto-added to
  an existing subscription.
- `@ebbjs/schema`'s `groupSystemEntity` gains the field, so `GroupFields`
  includes `apps` on every client group read. `@ebbjs/core`'s `GroupSeed`
  gains an optional `apps` map.

Live scope changes (`groups_changed`) are tracked separately; today a scope
edit takes effect on the app's next handshake.
