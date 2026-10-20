import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue } from "@ebbjs/core";

import {
  MAP_FIELD_FLIP_POINT,
  MAP_FIELD_SHARD_COUNT,
  isShardedMapField,
} from "../internal/map-field";
import { createReplica, holdAll } from "./replica";

const leaf = (value: unknown, ms = 1, updateId = `u_${ms}`): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

/** An N-run content map, one leaf per run. */
const content = (n: number): Record<string, FieldValue> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`run_${i}`, leaf(`v${i}`, 1, `u_${i}`)]));

const action = (
  method: "put" | "patch",
  fields: Record<string, FieldValue>,
  gsn: number,
  ms: number,
): Action => ({
  id: `act_${gsn}`,
  actor_id: "user_1",
  hlc: makeHlc(ms),
  gsn,
  updates: [
    {
      id: `upd_${gsn}`,
      subject_id: "doc_1",
      subject_type: "doc",
      method,
      data: { fields },
    },
  ],
});

const putDoc = (n: number): Action =>
  action("put", { title: leaf("Doc"), content: { map: content(n) } }, 1, 1);

const patchRun = (key: string, value: string, gsn: number, ms: number): Action =>
  action("patch", { content: { map: { [key]: leaf(value, ms) } } }, gsn, ms);

const contentOf = (entity: Entity | undefined): FieldValue | undefined =>
  entity?.data.fields.content;

describe("replica map fields over the flip point", () => {
  it("adopts a large map from a put and keeps the wire view intact", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(MAP_FIELD_FLIP_POINT + 100);
    replica.ingest(put, put.updates, 1);

    const content = contentOf(replica.get("doc_1"));
    expect(content !== undefined && isShardedMapField(content)).toBe(true);
    expect(Object.keys((content as { map: Record<string, FieldValue> }).map)).toHaveLength(
      MAP_FIELD_FLIP_POINT + 100,
    );
  });

  it("merges a one-key patch with the same result as the flat wire merge", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const patch = patchRun("run_42", "edited", 2, 2);
    replica.ingest(patch, patch.updates, 2);

    const content = contentOf(replica.get("doc_1")) as { map: Record<string, FieldValue> };
    expect(content.map.run_42).toEqual(leaf("edited", 2));
    expect(Object.keys(content.map)).toHaveLength(1000);
  });

  it("keeps a losing patch on the same data reference across the container", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const before = replica.get("doc_1");
    const revision = replica.revision;

    const patch = patchRun("run_0", "stale", 2, 0);
    replica.ingest(patch, patch.updates, 2);

    const after = replica.get("doc_1");
    expect(after?.data).toBe(before?.data);
    expect(replica.revision).toBe(revision);
  });

  it("bumps the revision on a winning patch through the container", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const revision = replica.revision;

    const patch = patchRun("run_0", "edited", 2, 2);
    replica.ingest(patch, patch.updates, 2);

    expect(replica.revision).toBeGreaterThan(revision);
  });

  it("bumps the revision on an equal-HLC tiebreak inside a container", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const revision = replica.revision;

    const patch = action("patch", { content: { map: { run_0: leaf("tie", 1, "u_zzz") } } }, 2, 1);
    replica.ingest(patch, patch.updates, 2);

    const content = contentOf(replica.get("doc_1")) as { map: Record<string, FieldValue> };
    expect(content.map.run_0).toEqual(leaf("tie", 1, "u_zzz"));
    expect(replica.revision).toBeGreaterThan(revision);
  });

  it("writes only the flat wire shape into the persisted record", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const patch = patchRun("run_0", "edited", 2, 2);
    replica.ingest(patch, patch.updates, 2);

    const record = replica.toRecord();
    const persisted = record.entities[0]?.data.fields.content as FieldValue;

    expect(isShardedMapField(persisted)).toBe(false);
    expect(persisted).toEqual({ map: { ...content(1000), run_0: leaf("edited", 2) } });
  });

  it("re-adopts the container when the record is loaded back", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(1000);
    replica.ingest(put, put.updates, 1);
    const record = replica.toRecord();

    const reloaded = createReplica({ materialization: holdAll });
    reloaded.load(record);

    const content = contentOf(reloaded.get("doc_1"));
    expect(content !== undefined && isShardedMapField(content)).toBe(true);
  });

  it("adopts a large map read through open", async () => {
    const row: Entity = {
      id: "doc_1",
      type: "doc",
      data: { fields: { title: leaf("Doc"), content: { map: content(600) } } },
      created_hlc: makeHlc(1),
      updated_hlc: makeHlc(1),
      deleted_hlc: null,
      last_gsn: 1,
    };
    const replica = createReplica({
      materialization: { holds: () => false },
      readEntity: async () => row,
    });

    const opened = await replica.open("doc_1");
    const openedContent = contentOf(opened ?? undefined);
    expect(openedContent !== undefined && isShardedMapField(openedContent)).toBe(true);
  });

  it("leaves a map below the flip point on the plain object", () => {
    const replica = createReplica({ materialization: holdAll });
    const put = putDoc(MAP_FIELD_FLIP_POINT - 1);
    replica.ingest(put, put.updates, 1);

    const content = contentOf(replica.get("doc_1"));
    expect(content !== undefined && isShardedMapField(content)).toBe(false);
  });
});

describe("shard layout", () => {
  it("keeps the configured shard count", () => {
    expect(MAP_FIELD_SHARD_COUNT).toBe(64);
  });
});
