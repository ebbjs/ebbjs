import { describe, expect, it } from "vitest";
import { makeHlc } from "@ebbjs/core";
import { buildTodoEntity, HLC_BASE } from "../testing/fixtures";
import { isValidReplicaRecord, REPLICA_RECORD_FORMAT } from "./replica-record";

const validRecord = (): unknown => ({
  format: REPLICA_RECORD_FORMAT,
  position: 3,
  revision: 1,
  entities: [buildTodoEntity("todo_1", "Hello", makeHlc(HLC_BASE))],
});

describe("isValidReplicaRecord", () => {
  it("accepts a well-formed record", () => {
    expect(isValidReplicaRecord(validRecord())).toBe(true);
  });

  it("accepts an empty entity set", () => {
    expect(isValidReplicaRecord({ ...(validRecord() as object), entities: [] })).toBe(true);
  });

  it("rejects a non-object", () => {
    for (const value of [null, undefined, "record", 7]) {
      expect(isValidReplicaRecord(value)).toBe(false);
    }
  });

  it("rejects an unknown format", () => {
    expect(isValidReplicaRecord({ ...(validRecord() as object), format: 999 })).toBe(false);
  });

  it("rejects a negative or fractional watermark", () => {
    expect(isValidReplicaRecord({ ...(validRecord() as object), position: -1 })).toBe(false);
    expect(isValidReplicaRecord({ ...(validRecord() as object), revision: 1.5 })).toBe(false);
  });

  it("rejects a non-array entity set", () => {
    expect(isValidReplicaRecord({ ...(validRecord() as object), entities: "nope" })).toBe(false);
  });

  it("rejects a malformed row", () => {
    const withEntities = (entities: unknown): unknown => ({
      ...(validRecord() as object),
      entities,
    });
    expect(isValidReplicaRecord(withEntities([null]))).toBe(false);
    expect(isValidReplicaRecord(withEntities([{ type: "todo" }]))).toBe(false);
    expect(isValidReplicaRecord(withEntities([{ id: "todo_1" }]))).toBe(false);
    expect(isValidReplicaRecord(withEntities([{ id: 123, type: "todo" }]))).toBe(false);
  });
});
