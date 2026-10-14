import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeFieldValue, type FieldValue } from "./action";

interface MergeVector {
  readonly name: string;
  readonly existing: FieldValue | null;
  readonly incoming: FieldValue;
  readonly merged: FieldValue;
}

const fixtureUrl = new URL("../../../../fixtures/merge_vectors.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  vectors: MergeVector[];
};

describe("mergeFieldValue shared merge vectors", () => {
  it("loads a non-empty vector set", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const existing = vector.existing === null ? undefined : vector.existing;

      expect(mergeFieldValue(existing, vector.incoming)).toEqual(vector.merged);
    });
  }
});
