/**
 * Rows examined by relationship and membership traversals.
 *
 * The adjacency index makes a traversal cost proportional to the
 * degree of the row it starts from, not the size of the type. This
 * counter is the observable proof: an entity load records one row, an
 * index read records the live rows it returns. The query executor's
 * legitimate `iterate` of a whole source type is deliberately not
 * counted — only the walk that an index is meant to replace.
 */

let rowsExamined = 0;

export function recordTraversalRows(count: number): void {
  rowsExamined += count;
}

interface TraversalCounter {
  readonly rowsExamined: number;
  reset(): void;
}

export const traversalCounter: TraversalCounter = {
  get rowsExamined(): number {
    return rowsExamined;
  },
  reset(): void {
    rowsExamined = 0;
  },
};
