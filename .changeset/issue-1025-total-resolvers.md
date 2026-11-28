---
"@ebbjs/client": minor
---

Make derived-index resolvers total and delete the `byIndexAll` fallback (#1025).

Every `ReplicaChange` states its whole movement (#1024), so an `IndexResolver`
never needs a "cannot say" answer. `IndexResolver` returns `readonly string[]`
instead of `readonly string[] | null`, and the dispatcher's second registration
table — `byIndexAll`, one entry under every index it declared, written on every
add and remove — is gone. Each declared index keeps one bucket map, and a
resolved key's lookup count is unchanged while the fallback lookup disappears.

- `relation-index.ts`, `exists-index.ts`, `scope-index.ts` and
  `membership-index.ts` lose their `null` arms and read the delta directly.
- The membership resolver no longer reads the changed row back: the delta's
  `before`/`after` pair names the entity a departed or refiled row can no longer
  state. `createIndexResolvers()` takes no `Replica`, and `membershipResolver`
  is the resolver itself.
- A relation index name the family cannot parse answers every target any pair
  moved on the change rather than falling back to every declarer. Validating a
  `<as>/<type>` pair against the schema is #1028.

An index name no resolver serves is now an unconditional error rather than a
silent widening to every declarer. `createChangeDispatcher`'s `add` refuses it
with a new, exported `UnknownIndexError` carrying the index, the resolver names
it does answer to, and — when the subscription registry re-states the refusal
for the query an author wrote — that subscription key. The check runs at that
one seam, so a refused `depend` restores the keys, claims, read set, acquire
generation and quiet period the entry held, and a refused `open` leaves no
subscription behind. The batch-level `try/catch` in `dispatch` still hands every
entry the batch, so one bad declaration cannot lose a batch for the rest.

This supersedes #1006's development-only warning: with a complete movement a
typo'd index name is a bug in every build, not a wider batch in production.
