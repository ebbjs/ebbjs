/**
 * Cross-language conformance for query semantics.
 *
 * Both this executor and `ebb_server`'s SQLite query path must reproduce
 * `fixtures/query_semantics_vectors.json`, so the two implementations of one
 * predicate language cannot drift. The suite runs the real filter path —
 * `filterToGroups` → `planQuery` → `executePlan` — over rows built from the
 * fixture, not a reimplementation of matching.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeHlc, type Entity } from "@ebbjs/core";
import type { Filter } from "@ebbjs/schema";

import { emptyQuery, filterToGroups } from "../query";
import { createRowsExecutor, executePlan } from "../query-execute";
import { planQuery } from "../query-plan";

interface VectorRow {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface VectorCase {
  readonly name: string;
  readonly filter: Filter | null;
  readonly expected: readonly string[];
}

const fixtureUrl = new URL("../../../../../fixtures/query_semantics_vectors.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  rows: VectorRow[];
  cases: VectorCase[];
};

const toEntity = (row: VectorRow): Entity => ({
  id: row.id,
  type: "todo",
  data: {
    fields: Object.fromEntries(
      Object.entries(row.fields).map(([field, value]) => [
        field,
        { value, update_id: `u_${row.id}`, hlc: makeHlc(1) },
      ]),
    ),
  },
  created_hlc: makeHlc(1),
  updated_hlc: makeHlc(1),
  deleted_hlc: null,
  last_gsn: 1,
});

describe("query semantics shared vectors", () => {
  it("loads a non-empty vector set", () => {
    expect(fixture.rows.length).toBeGreaterThan(0);
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  const rows = fixture.rows.map(toEntity);
  const executor = createRowsExecutor(rows);

  for (const vector of fixture.cases) {
    it(vector.name, () => {
      const plan = planQuery({ ...emptyQuery("todo"), groups: filterToGroups(vector.filter) });
      const ids = executePlan(plan, executor).map((row) => row.id);

      expect([...ids].sort()).toEqual([...vector.expected].sort());
    });
  }
});
