/**
 * The traversal counter measures adjacency-read cost: an entity load
 * counts one row, an index read counts its live rows. Tests seed it
 * directly and read it back through the exported accessor.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { recordTraversalRows, traversalCounter } from "../traversal-counter";

describe("traversalCounter", () => {
  beforeEach(() => traversalCounter.reset());

  it("starts at zero after reset", () => {
    expect(traversalCounter.rowsExamined).toBe(0);
  });

  it("accumulates the rows each traversal records", () => {
    recordTraversalRows(3);
    recordTraversalRows(2);
    expect(traversalCounter.rowsExamined).toBe(5);
  });

  it("returns to zero on reset", () => {
    recordTraversalRows(7);
    traversalCounter.reset();
    expect(traversalCounter.rowsExamined).toBe(0);
  });
});
