---
"@ebbjs/core": minor
"@ebbjs/storage": minor
"@ebbjs/client": minor
"@ebbjs/react": minor
"@ebbjs/codemirror": minor
---

`receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.
