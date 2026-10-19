/**
 * Workspace fixture for the replica read-model benchmark (#503).
 *
 * The shape mirrors the epic #495 spike so its numbers stay comparable:
 *
 *   - `n` `page` rows (title, icon, updated_at) — the held metadata,
 *   - one `parent` edge per page (a BRANCH-ary tree) plus REFS_PER_PAGE
 *     `references` edges per page — held `relationship` rows,
 *   - one `entityGroup` row per page plus a workspace `group` — held,
 *   - heavy `page_content` rows that stay windowed.
 *
 * Every row is generated once, in memory: seeding through the memory
 * adapter's `set` is O(n²) (39,999 inserts took 507.7 s on the spike), so
 * the benchmark builds a `ReplicaRecord` and calls `replica.load(record)`.
 *
 * Pure and parameterised so the harness test can assert the same shape at a
 * few hundred rows without running the 10k bench.
 */

import { isFieldLeaf, type Entity, type FieldValue } from "@ebbjs/core";
import type { ReplicaRecord } from "@ebbjs/storage/types";

/** The entity type the shipped residency policy leaves windowed. */
export const ON_DEMAND_TYPE = "page_content";

/** The one group every page is filed into. */
export const WORKSPACE_GROUP_ID = "grp_ws";

/** `updated_at` of page `i` is `UPDATED_AT_BASE + i`; a test fixture value, not a clock. */
export const UPDATED_AT_BASE = 1_700_000_000_000;

/**
 * The record shape version in `@ebbjs/storage`'s `internal/replica-record.ts`.
 * Not exported from the package, and `load` ignores a record with any other
 * value, so the fixture has to state it.
 */
const REPLICA_RECORD_FORMAT = 1;

/**
 * Distinct bodies the store materializes so the windowed read path is real.
 * Bodies are never all materialized: 10k heavy bodies is ~298 MB, and the
 * footprint of the full body set is measured from one representative row.
 */
const BODY_DOCS = 100;

/** Bodies written into the record so `load` can be seen dropping them. */
const RECORD_BODY_DOCS = 3;

export interface BenchConfig {
  /** Documents (`page` rows). */
  readonly n: number;
  /** Distinct ids each timed traversal cycles over. */
  readonly sample: number;
  /** Children per page in the parent tree. */
  readonly branch: number;
  /** `references` edges per page. */
  readonly refsPerPage: number;
  /** Blocks in a representative body. */
  readonly bodyBlocks: number;
  /** Characters per body block. */
  readonly bodyChars: number;
}

export const DEFAULT_CONFIG: BenchConfig = {
  n: 10_000,
  sample: 25,
  branch: 10,
  refsPerPage: 2,
  bodyBlocks: 120,
  bodyChars: 200,
};

const positiveInt = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

/** Read the env-overridable knobs; the report header echoes what was used. */
export const configFromEnv = (env: Readonly<Record<string, string | undefined>>): BenchConfig => ({
  n: positiveInt(env, "N", DEFAULT_CONFIG.n),
  sample: positiveInt(env, "SAMPLE", DEFAULT_CONFIG.sample),
  branch: positiveInt(env, "BRANCH", DEFAULT_CONFIG.branch),
  refsPerPage: positiveInt(env, "REFS_PER_PAGE", DEFAULT_CONFIG.refsPerPage),
  bodyBlocks: positiveInt(env, "BODY_BLOCKS", DEFAULT_CONFIG.bodyBlocks),
  bodyChars: positiveInt(env, "BODY_CHARS", DEFAULT_CONFIG.bodyChars),
});

export const configWith = (overrides: Partial<BenchConfig>): BenchConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

export interface WorkspaceCounts {
  readonly pages: number;
  readonly relationships: number;
  readonly entityGroups: number;
  readonly groups: number;
  /** Rows `load` holds resident. */
  readonly heldRows: number;
  /** Body rows the store can serve. */
  readonly bodyRows: number;
  /** Body rows written into the record, which `load` drops. */
  readonly recordBodyRows: number;
}

export interface Workspace {
  readonly config: BenchConfig;
  /** Metadata rows plus a few `page_content` rows, in load order. */
  readonly record: ReplicaRecord;
  /** Every row by id — the store the replica reads bodies through. */
  readonly rows: ReadonlyMap<string, Entity>;
  /** Body ids spread across the id space, newest first. */
  readonly bodyIds: readonly string[];
  readonly counts: WorkspaceCounts;
  /** Serialized bytes of one representative body row. */
  readonly bodyBytes: number;
}

// ---------------------------------------------------------------------------
// Ids and positional structure
// ---------------------------------------------------------------------------

export const pageId = (index: number): string => `page_${index}`;
export const bodyId = (index: number): string => `body_${index}`;
export const entityGroupId = (index: number): string => `eg_${index}`;

/** The page index a page's `parent` edge points at (`page_0` is the root). */
export const parentIndexOf = (index: number, branch: number): number =>
  Math.floor((index - 1) / branch);

/** The page index the `ref`th `references` edge of page `index` points at. */
export const referenceTargetIndex = (index: number, ref: number, n: number): number =>
  (index * 7 + ref * 13 + 1) % n;

/** `count` indices spread across the id space, so reads hit every degree. */
export const spreadIndices = (n: number, count: number): readonly number[] => {
  const size = Math.min(count, n);
  return Array.from({ length: size }, (_, k) => Math.floor(((k + 0.5) * n) / size));
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const leaf = (updateId: string, value: unknown): FieldValue => ({ value, update_id: updateId });

const row = (id: string, type: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  type,
  data: { fields },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/**
 * One immutable content map shared by every body. Only the row id differs, so
 * the representative row's serialized bytes times `n` is the hypothetical
 * body footprint while the store holds only the bodies it can serve.
 */
const bodyContent = (config: BenchConfig): FieldValue => {
  const text = "lorem ipsum dolor sit amet ".repeat(Math.ceil(config.bodyChars / 27));
  return {
    map: Object.fromEntries(
      Array.from({ length: config.bodyBlocks }, (_, block) => [
        `block_${block}`,
        leaf(`u_body_block_${block}`, `${text} [block ${block}]`.slice(0, config.bodyChars + 12)),
      ]),
    ),
  };
};

const pageRow = (index: number): Entity =>
  row(pageId(index), "page", {
    title: leaf(`u_page_${index}_title`, `Document ${index} — a page in a very large workspace`),
    icon: leaf(`u_page_${index}_icon`, "📄"),
    updated_at: leaf(`u_page_${index}_updated_at`, UPDATED_AT_BASE + index),
  });

const parentRow = (index: number, branch: number): Entity =>
  row(`rel_parent_${index}`, "relationship", {
    source_id: leaf(`u_rel_parent_${index}_source`, pageId(index)),
    target_id: leaf(`u_rel_parent_${index}_target`, pageId(parentIndexOf(index, branch))),
    type: leaf(`u_rel_parent_${index}_type`, "page"),
    field: leaf(`u_rel_parent_${index}_field`, "parent"),
  });

const referenceRow = (index: number, ref: number, n: number): Entity => {
  const id = `rel_ref_${index}_${ref}`;
  return row(id, "relationship", {
    source_id: leaf(`u_${id}_source`, pageId(index)),
    target_id: leaf(`u_${id}_target`, pageId(referenceTargetIndex(index, ref, n))),
    type: leaf(`u_${id}_type`, "page"),
    field: leaf(`u_${id}_field`, "references"),
  });
};

const entityGroupRow = (index: number): Entity =>
  row(entityGroupId(index), "entityGroup", {
    entity_id: leaf(`u_${entityGroupId(index)}_entity`, pageId(index)),
    group_id: leaf(`u_${entityGroupId(index)}_group`, WORKSPACE_GROUP_ID),
  });

const groupRow = (): Entity =>
  row(WORKSPACE_GROUP_ID, "group", { name: leaf("u_grp_ws_name", "Workspace") });

const bodyRow = (index: number, content: FieldValue): Entity =>
  row(bodyId(index), ON_DEMAND_TYPE, { content });

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const referenceRows = (config: BenchConfig): readonly Entity[] =>
  config.refsPerPage === 0
    ? []
    : Array.from({ length: config.n * config.refsPerPage }, (_, k) =>
        referenceRow(Math.floor(k / config.refsPerPage), k % config.refsPerPage, config.n),
      );

export const createWorkspace = (config: BenchConfig): Workspace => {
  const content = bodyContent(config);
  const pages = Array.from({ length: config.n }, (_, index) => pageRow(index));
  const entityGroups = Array.from({ length: config.n }, (_, index) => entityGroupRow(index));
  const parents = Array.from({ length: Math.max(0, config.n - 1) }, (_, k) =>
    parentRow(k + 1, config.branch),
  );
  const references = referenceRows(config);
  const relationships = [...parents, ...references];

  const bodyIndices = spreadIndices(config.n, BODY_DOCS);
  const bodies = bodyIndices.map((index) => bodyRow(index, content));
  const recordBodyRows = bodies.slice(0, RECORD_BODY_DOCS);

  const metadata = [...pages, ...entityGroups, groupRow(), ...relationships];
  const record: ReplicaRecord = {
    format: REPLICA_RECORD_FORMAT,
    position: 0,
    revision: 1,
    entities: [...metadata, ...recordBodyRows],
  };

  const bodyIds = bodyIndices.map(bodyId);
  const representative = bodyRow(Math.floor(config.n / 2), content);

  return {
    config,
    record,
    rows: new Map([...metadata, ...bodies].map((entity) => [entity.id, entity])),
    bodyIds,
    counts: {
      pages: pages.length,
      relationships: relationships.length,
      entityGroups: entityGroups.length,
      groups: 1,
      heldRows: metadata.length,
      bodyRows: bodies.length,
      recordBodyRows: recordBodyRows.length,
    },
    bodyBytes: Buffer.byteLength(JSON.stringify(representative)),
  };
};

// ---------------------------------------------------------------------------
// Derived shape
// ---------------------------------------------------------------------------

/** A string field's value, or `undefined` for a map/absent/malformed field. */
export const stringField = (entity: Entity, name: string): string | undefined => {
  const field = entity.data?.fields?.[name];
  if (field === undefined || !isFieldLeaf(field)) return undefined;
  return typeof field.value === "string" ? field.value : undefined;
};

export interface IndexKeyCounts {
  readonly reverseKeys: number;
  readonly forwardKeys: number;
  readonly reverseRows: number;
  readonly forwardRows: number;
}

/**
 * Distinct adjacency keys the record implies, derived from the rows. The
 * replica does not expose its indices, so this reports what `load` built
 * rather than reading it back; the key encoding only needs to be injective
 * per `(direction, field, type, id)`, which the real index's separators also
 * guarantee.
 */
export const summariseIndexKeys = (rows: readonly Entity[]): IndexKeyCounts => {
  const reverse = new Set<string>();
  const forward = new Set<string>();
  let reverseRows = 0;
  let forwardRows = 0;

  for (const entity of rows) {
    if (entity.deleted_hlc !== null) continue;
    const source = stringField(entity, "source_id");
    const target = stringField(entity, "target_id");
    const field = stringField(entity, "field");
    const type = stringField(entity, "type");
    if (entity.type === "relationship" && source && target && field && type) {
      reverse.add(JSON.stringify([field, type, target]));
      forward.add(JSON.stringify([field, type, source]));
      reverseRows += 1;
      forwardRows += 1;
      continue;
    }
    const member = stringField(entity, "entity_id");
    const group = stringField(entity, "group_id");
    if (entity.type === "entityGroup" && member && group) {
      reverse.add(JSON.stringify(["groups", "entityGroup", group]));
      forward.add(JSON.stringify(["groups", "entityGroup", member]));
      reverseRows += 1;
      forwardRows += 1;
    }
  }

  return {
    reverseKeys: reverse.size,
    forwardKeys: forward.size,
    reverseRows,
    forwardRows,
  };
};
