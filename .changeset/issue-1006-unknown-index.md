---
"@ebbjs/client": minor
---

Refuse an index no resolver serves at registration in development (#1006).

A declared index name the dispatcher has no resolver for — a typo, or a family
the registry never registered — used to be treated exactly like a resolver
answering `null`: every entry that declared the index was touched. Correct and
merely slower, so nothing told the author.

`createChangeDispatcher` takes `requireResolvers`, and a dispatcher built with it
refuses such a declaration in `add` with a new `UnknownIndexError` naming the
offending index and the resolvers the dispatcher does have. The check runs before
the entry is re-indexed, so a refusal leaves the dispatcher and the entry's
previous indexing untouched. The subscription registry sets the flag from the
existing dev gate, so a development build fails at subscribe time while a
production build keeps the conservative breadth rather than crashing on a name it
cannot serve.

`UnknownIndexError` is exported: it is thrown out of `subscribe` and
`SubscriptionWriter.depend`, so a caller that opens reads programmatically can
catch it. The registry re-states the refusal with the subscription key that
declared the index, so the message names the query an author has to go and fix.

The breadth #961 gave is unchanged where it still belongs: a resolver that has a
name but cannot answer a change with `null` still touches every entry that
declared it. Only a name nothing serves is now an error, and only in development.
