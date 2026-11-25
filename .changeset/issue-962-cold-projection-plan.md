---
"@ebbjs/client": patch
---

Run a cold projection's plan once (#962).

The reactive path narrows the page with one plan and, when a projected component
is not resident, hands that narrowed page to acquisition instead of planning it
again for the acquire-and-project pass. The page is exactly what the second run
would recompute, so the rows, `groupIds`, patching, and lease lifetime are
unchanged; the results view still reconciles a change that lands while
acquisition is in flight. A cold 10,000-row projection drops from two plan runs
and 30,000 rows examined to one and 20,000. Its wall clock is dominated by the
acquisition and the result's claims, so that is not where the saving shows: the
plan a cold read no longer runs is the one removed.
