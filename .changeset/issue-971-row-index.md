---
"@ebbjs/storage": minor
"@ebbjs/client": minor
---

The replica keeps one row index instead of five ad-hoc indices.

Each row has one entry that owns its model, the components it carries, its
`ebb/link` edges, its membership, its declared versions, and the leaf and
`ebb/*` values a query decides on. A separate value cache holds map-shaped user
components, so installing or dropping one is a residency move that never touches
an index read and never journals. `iterate`, `components`, `relationships` in
both directions, `memberships`, `membershipLinks` and `componentVersion` answer
from the entry alone; `get` composes the entry with the values still resident.

Query planning and narrowing read index rows. Projection reads the composed row
after acquisition, so a filter or sort never waits on storage and a page still
projects every value it selected.
