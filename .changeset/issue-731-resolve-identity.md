---
"@ebbjs/client": minor
---

`resolveIdentity` — learn the actor before constructing a client.

`resolveIdentity({ serverUrl, fetchImpl?, signal? })` calls `GET /sync/identity`
and returns the actor the server authenticated, so a tailscale deployment does
not have to ask the browser for an id it cannot know:

```ts
const identity = await resolveIdentity({ serverUrl });
const client = createClient({ serverUrl, actorId: identity.actorId });
```

The request sends no `x-ebb-actor-id`; the server is authoritative. The result
carries `actorId`, `provider` (`"bypass" | "external" | "tailscale"`), and the
provider's optional `displayName` / `providerId`. Payload validation is strict:
a missing or empty `actor_id`, an unknown provider, or a mistyped optional field
is an `invalid-response`, never a half-read identity.

Failures throw `IdentityResolutionError` with a `kind` — `network`,
`unauthorized` (401), `invalid-response` (an HTML proxy page, a non-JSON body),
or `http` with the status — so the caller can act instead of retrying in a loop.
A fetch rejection keeps its original error as `cause`.

Resolution needs connectivity once: cache `identity.actorId` and start offline
with it afterwards. A Tailscale login change is a new actor — a cached id then
earns `actor_mismatch`; re-resolve, rebuild the client, and use the new actor's
storage.
