---
"@ebbjs/storage": minor
---

Journal the membership pair a membership row states on each side of a change
(#1010).

A `ReplicaChange`'s `delta.membership` names the `ebb/membership` pair the row
stated before and after the change: `{ entityId, groupId }`, or `null` on a side
that stated none. It is what a membership departure can state — an unshared or
evicted row is gone, so a change that names only the group cannot say which
entity lost it, and one that names only the entity cannot say which group. The
group rides the same part, so a scoped reader learns which group a row entered or
left from one side rather than from a second part computed beside it.

The part is recorded once the pair moved: a row arriving names the pair with no
before side, an unshared or evicted row names it with no after side, a refile
names both, and a value write that keeps the pair carries no `membership` at all.
A half-present pair — one half of the value without the other, which no writer
produces — states no pair, so a reader falls back to every entry rather than to a
key. Nothing is persisted and no change shape breaks: the field is optional, and
an ordinary value write still carries no delta.
