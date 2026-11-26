---
"@ebbjs/storage": minor
---

Journal the member a membership row files on each side of a change (#1010).

A `ReplicaChange`'s `delta` now optionally carries `membership`: the member
entity id the row's `ebb/membership` filed before and after the change, `null`
on a side that filed nobody. It is what a membership departure can state — an
unshared or evicted row is gone, and a change that names only the group cannot
say which entity lost it.

The part is recorded only when the filed subject moved, like every other part:
a row arriving names the subject with no before side, an unshared or evicted
row names it with no after side, a refile names both, and a value write that
keeps the subject carries no `membership` at all. Nothing is persisted and no
change shape breaks: the field is optional, and an ordinary value write still
carries no delta.
