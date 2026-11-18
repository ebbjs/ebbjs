---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/write": minor
---

The sync client's HTTP contract, its routes, its composite keys, and its value
comparison each have one owner.

`client/src/sync/http.ts` owns the actor header, the base-URL shape, and one body-read
policy for every request. `client/src/sync/endpoints.ts` names every route the client
calls — the group listing included, which test mocks now dispatch on instead of
re-deriving its prefix. `client/src/sync/keys.ts` builds composite keys with their parts
escaped, so a part that contains a separator no longer aliases two entries. `@ebbjs/core`
gains `structuralEqual` and `canonicalKey`, which replace the query cache's `sameValue`,
the query executor's `valuesEqual`, the schema hash's `stableStringify`, and the entity
diff's `stableValueString`.

`canonicalKey(value, { undefinedAs })` keeps both spellings of an absent value: the schema
hash keeps `"null"`, the entity diff keeps `"undefined"` so absence and a stored `null`
stay distinct. Both encode byte-for-byte as before.

No wire value changed. No schema hash changed. The conflict-slot, hold, migration, and
query-cache key strings changed, all in memory only — none is persisted or sent.

```diff
-const response = await this.fetchImpl(`${this.serverUrl}/sync/handshake`, init);
-if (!response.ok) {
-  const text = await response.text().catch(() => "");
-  throw new Error(`handshake failed: ${response.status} ${text}`);
-}
+const data = await requestJson<HandshakeResponse>(
+  this.fetchImpl,
+  `${this.serverUrl}${handshakePath()}`,
+  init,
+  "handshake",
+);
```
