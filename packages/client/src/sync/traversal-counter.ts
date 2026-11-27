/**
 * Rows examined by relationship and membership traversals.
 *
 * The adjacency index makes a traversal cost proportional to the
 * degree of the row it starts from, not the size of the type. This
 * counter is the observable proof: an entity load records one row, an
 * index read records the live rows it returns. The query executor's
 * legitimate `iterate` of a whole source type is deliberately not
 * counted — only the walk that an index is meant to replace.
 *
 * A propagating query result is counted the same way (#942): a re-run records
 * every row its scan materialized, a patch records the rows it re-read by id.
 * That is what makes "a 10,000-row re-run examines 10,000 rows; a one-row patch
 * examines one" observable rather than a claim.
 *
 * An `executePlan` run is counted too (#962): planning a read's page is its
 * largest fixed cost, so the count per read says whether the page was planned
 * once — a read that projected a resident page or handed it to acquisition
 * plans once, and a regression that planned it twice would show here.
 */

let rowsExamined = 0;
let resultRowsRead = 0;
let planRuns = 0;

export function recordTraversalRows(count: number): void {
  rowsExamined += count;
}

/** One materialization of `count` rows for a propagating query result. */
export function recordResultRows(count: number): void {
  resultRowsRead += count;
}

/**
 * One `executePlan` execution. It is a propagation cost, not a diagnostic: an
 * executor built outside a propagating read records into it all the same, so a
 * reader resets it around the work it measures.
 */
export function recordPlanRun(): void {
  planRuns += 1;
}

interface TraversalCounter {
  readonly rowsExamined: number;
  /**
   * Rows a propagating query result materialized, however it reached them: a
   * re-run's scan rows plus a patch's by-id reads, plus a row subscription's
   * one row per change.
   */
  readonly resultRowsRead: number;
  /**
   * `executePlan` executions since the last reset. A read plans its page once,
   * resident or acquiring; a redundant run of the same page would show here as
   * the propagation cost it is (#962).
   */
  readonly planRuns: number;
  reset(): void;
}

export const traversalCounter: TraversalCounter = {
  get rowsExamined(): number {
    return rowsExamined;
  },
  get resultRowsRead(): number {
    return resultRowsRead;
  },
  get planRuns(): number {
    return planRuns;
  },
  reset(): void {
    rowsExamined = 0;
    resultRowsRead = 0;
    planRuns = 0;
  },
};
