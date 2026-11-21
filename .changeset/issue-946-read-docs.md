---
"@ebbjs/client": minor
---

Documentation only: the shipped README and the comments the build emits into
`dist/index.d.ts` agree that `get(id, { select })` is the public single-row
read, not internal, and the two known index-dependency gaps now name their
owners (#961, #962).

No runtime or type change. The tarball's own docs contradicted the type they
annotated, which is the kind of thing a reader acts on.
