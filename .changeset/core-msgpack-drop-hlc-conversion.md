---
"@ebbjs/core": minor
---

MessagePack now carries every value exactly as sent: the HLC-as-integer conversion
layer is gone.

`encode`/`decode` and their sync twins wrapped msgpack in `convert.ts`, which walked
the whole payload turning HLC-shaped strings into numbers on the way out and
rewriting large integers into strings on the way back. Neither direction did what
it meant. A packed HLC is `ms << 16`, ~1.1e17, above `Number.MAX_SAFE_INTEGER`, so
`hlcToInteger` always returned the string it was given — every HLC already travelled
as a decimal string. The inverse turned any decoded integer above 1e12 into a
string, because it could not tell an HLC from a phone number, an account id, or an
11–15 digit code. `SyncClient.submitActions` posts every Action through
`encodeSync`, so both halves were retyping ordinary data on the live write path.

The module is deleted rather than gated: nothing outside `msgpack/index.ts`
imported it and the package never re-exported it. On the wire, a real HLC is
unchanged.
