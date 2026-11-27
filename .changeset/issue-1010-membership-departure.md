---
"@ebbjs/client": minor
---

Resolve a membership departure to the entity it filed (#1010).

The membership index a row subscription declares now distinguishes "this change
names no key" from "cannot say". A live membership row answers the entity it
files — a tombstone still states it. A row that no longer states it, because the
replica dropped it (an eviction) or the change took the subject away, answers the
member half of each `delta.membership` pair the change records, so the row
subscription watching that entity is touched instead of skipped. A refile
answers both entities it moved the row between, since each lost or gained a
group.

`[]` stays reserved for a change that names no membership row this index answers
for, or one whose delta names no member on either side. Anything else — a change
with no delta at all, even one whose row is readable — answers "cannot say" and
touches every row subscription that declared the index: the row only proves the
side it is on now. The visible effect is that an unshare or an eviction now
reaches the row subscription for the entity it removed from a group, and the
fallback breadth survives for a journal that cannot name the subject.
