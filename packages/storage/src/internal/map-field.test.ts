import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFieldMap, makeHlc, type FieldValue } from "@ebbjs/core";

import {
  MAP_FIELD_FLIP_POINT,
  MAP_FIELD_SHARD_COUNT,
  adoptMapField,
  adoptMapFields,
  isShardedMapField,
  mapFieldFromWire,
  mapFieldShards,
  mapFieldToWire,
  mergeResidentFieldValue,
  toWireMapFields,
} from "./map-field";

const leaf = (value: unknown, ms = 1, updateId = `u_${ms}`): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

/** An N-run content map, one leaf per run. */
const content = (n: number): Record<string, FieldValue> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`run_${i}`, leaf(`v${i}`, 1, `u_${i}`)]));

/** Render a field value back to the flat wire shape, container or not. */
const wireOf = (field: FieldValue | undefined): FieldValue | undefined => {
  if (field === undefined) return undefined;
  return isFieldMap(field) ? { map: mapFieldToWire(field) } : field;
};

describe("sharded map-field container", () => {
  it("round-trips the flat wire shape", () => {
    const wire = content(3);
    const field = mapFieldFromWire(wire);

    expect(isShardedMapField(field)).toBe(true);
    expect(mapFieldToWire(field)).toEqual(wire);
    expect(mapFieldToWire(field)).toBe(mapFieldToWire(field));
  });

  it("keeps the map variant's wire shape and JSON encoding", () => {
    const wire = content(2);
    const field = mapFieldFromWire(wire);

    expect(isFieldMap(field)).toBe(true);
    expect(Object.keys(field)).toEqual(["map"]);
    expect(JSON.parse(JSON.stringify(field))).toEqual({ map: wire });
  });

  it("exposes exactly one shard per configured slot", () => {
    expect(mapFieldShards(mapFieldFromWire(content(0)))).toHaveLength(MAP_FIELD_SHARD_COUNT);
  });
});

/** The shared cross-language merge vectors are the parity contract. */
interface MergeVector {
  readonly name: string;
  readonly existing: FieldValue | null;
  readonly incoming: FieldValue;
  readonly merged: FieldValue;
}

const fixturePath = path.resolve(process.cwd(), "../../fixtures/merge_vectors.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  vectors: MergeVector[];
};

describe("merge parity with mergeFieldValue", () => {
  it("loads a non-empty vector set", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const existing = vector.existing === null ? undefined : vector.existing;
      // Force the container path for map-over-map vectors so the parity check
      // runs against the resident representation, not the plain-object fallback.
      const resident =
        existing !== undefined && isFieldMap(existing) ? mapFieldFromWire(existing.map) : existing;

      expect(wireOf(mergeResidentFieldValue(resident, vector.incoming))).toEqual(vector.merged);
    });
  }

  it("recurses into nested plain maps inside a shard", () => {
    const existing = mapFieldFromWire({
      block_1: { map: { text: leaf("old", 1, "u_a"), type: leaf("p", 1, "u_b") } },
    });
    const merged = mergeResidentFieldValue(existing, {
      map: { block_1: { map: { text: leaf("new", 2, "u_c") } } },
    });

    expect(wireOf(merged)).toEqual({
      map: {
        block_1: { map: { text: leaf("new", 2, "u_c"), type: leaf("p", 1, "u_b") } },
      },
    });
  });
});

describe("flip point", () => {
  it("pins the run count at which a plain object becomes a sharded container", () => {
    expect(MAP_FIELD_FLIP_POINT).toBe(500);
  });

  it("keeps a map below the flip point on the plain object", () => {
    const field = { map: content(MAP_FIELD_FLIP_POINT - 1) };
    const merged = mergeResidentFieldValue(field, {
      map: { run_0: leaf("new", 2, "u_new") },
    });

    expect(isShardedMapField(merged)).toBe(false);
    expect(isFieldMap(merged)).toBe(true);
  });

  it("adopts the sharded container at the flip point", () => {
    const field = { map: content(MAP_FIELD_FLIP_POINT) };
    const merged = mergeResidentFieldValue(field, {
      map: { run_0: leaf("new", 2, "u_new") },
    });

    expect(isShardedMapField(merged)).toBe(true);
  });

  it("adopts when a patch grows a map across the flip point", () => {
    const field = { map: content(MAP_FIELD_FLIP_POINT - 1) };
    const merged = mergeResidentFieldValue(field, {
      map: { run_added: leaf("new", 2, "u_new") },
    });

    expect(isShardedMapField(merged)).toBe(true);
  });

  it("does not adopt below the flip point through the field record", () => {
    const fields = { content: { map: content(MAP_FIELD_FLIP_POINT - 1) }, title: leaf("t") };
    expect(adoptMapFields(fields)).toBe(fields);
    expect(adoptMapField(fields.content)).toBe(fields.content);
  });
});

describe("copy-on-write over shards", () => {
  it("copies only the shard a winning key lands in", () => {
    const field = mapFieldFromWire(content(5000));
    const merged = mergeResidentFieldValue(field, {
      map: { run_0: leaf("new", 2, "u_new") },
    });
    expect(isShardedMapField(merged)).toBe(true);
    if (!isFieldMap(merged) || !isShardedMapField(merged)) {
      throw new Error("expected a sharded container");
    }

    const before = mapFieldShards(field);
    const after = mapFieldShards(merged);
    const copied = after.filter((shard, index) => shard !== before[index]);
    expect(copied).toHaveLength(1);
    expect(mapFieldToWire(merged)).toEqual({ ...content(5000), run_0: leaf("new", 2, "u_new") });
  });

  it("reuses the whole container when the patch loses", () => {
    const field = mapFieldFromWire(content(1000));
    const merged = mergeResidentFieldValue(field, {
      map: { run_0: leaf("old", 0, "u_old") },
    });

    expect(merged).toBe(field);
  });
});

describe("record boundary", () => {
  it("flattens containers back to the wire shape", () => {
    const fields = {
      content: mapFieldFromWire(content(600)),
      title: leaf("t"),
    };
    const wire = toWireMapFields(fields);

    expect(wire).not.toBe(fields);
    expect(isShardedMapField(wire.content as FieldValue)).toBe(false);
    expect(wire.content).toEqual({ map: content(600) });
    expect(wire.title).toBe(fields.title);
  });

  it("returns the same record when nothing is sharded", () => {
    const fields = { content: { map: content(3) }, title: leaf("t") };
    expect(toWireMapFields(fields)).toBe(fields);
  });
});
