/**
 * Workspace fixture for the replica read-model benchmark (#503).
 *
 * The shape mirrors the epic #495 spike so its numbers stay comparable:
 *
 *   - `n` `page` rows (title, icon, updated_at) — the resident metadata,
 *   - one `parent` edge per page (a BRANCH-ary tree) plus REFS_PER_PAGE
 *     `references` edges per page — resident `relationship` rows,
 *   - one `ebb/membership` row per page plus a workspace `ebb/group` — resident,
 *   - heavy `page_content` rows the record leaves out, so the store serves them.
 *
 * Every row is generated once, in memory: seeding through the memory
 * adapter's `set` is O(n²) (39,999 inserts took 507.7 s on the spike), so
 * the benchmark builds a `ReplicaRecord` and calls `replica.load(record)`.
 *
 * Pure and parameterised so the harness test can assert the same shape at a
 * few hundred rows without running the 10k bench.
 */

import {
  carriesComponent,
  isFieldLeaf,
  linkEdges,
  systemValue,
  type Entity,
  type FieldValue,
} from "@ebbjs/core";
import { REPLICA_RECORD_FORMAT } from "@ebbjs/storage/replica";
import type { ReplicaRecord } from "@ebbjs/storage/types";

/** The model whose rows only the store carries: a read installs them under a lease. */
export const BODY_TYPE = "page_content";

/** The one group every page is filed into. */
export const WORKSPACE_GROUP_ID = "grp_ws";

/** `updated_at` of page `i` is `UPDATED_AT_BASE + i`; a test fixture value, not a clock. */
export const UPDATED_AT_BASE = 1_700_000_000_000;

/**
 * Distinct bodies the store materializes so the windowed read path is real.
 * Bodies are never all materialized: 10k heavy bodies is ~298 MB, and the
 * footprint of the full body set is measured from one representative row.
 */
const BODY_DOCS = 100;

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
  /** Edge keys the pages carry: `parent` plus `references`. */
  readonly relationships: number;
  readonly memberships: number;
  readonly groups: number;
  /** Metadata rows the record carries, so `load` makes them resident. */
  readonly residentRows: number;
  /** Body rows the store can serve. */
  readonly bodyRows: number;
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
export const membershipRowId = (index: number): string => `eg_${index}`;

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

const row = (id: string, model: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  model,
  data: { fields },
  exists: true,
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

/** The nesting that is one edge's key: accessor, type label, target. */
type LinkLeaves = Record<string, Record<string, Record<string, FieldValue>>>;

/** Wrap the nesting as the `ebb/link` component's map value. */
const linkValue = (leaves: LinkLeaves): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(leaves).map(([as, byType]) => [
      as,
      {
        map: Object.fromEntries(
          Object.entries(byType).map(([type, byTarget]) => [type, { map: byTarget }]),
        ),
      },
    ]),
  ),
});

/**
 * The edges one page carries: its `parent` key (except the root's) and its
 * `references`. A link is a key of its source row, so a page's edges live on
 * the page.
 */
const pageLink = (config: BenchConfig, index: number): FieldValue => {
  const leaves: LinkLeaves = {};
  const add = (as: string, targetId: string, updateId: string): void => {
    const byType = (leaves[as] ??= {});
    const byTarget = (byType.page ??= {});
    byTarget[targetId] = leaf(updateId, true);
  };
  if (index > 0) add("parent", pageId(parentIndexOf(index, config.branch)), `u_parent_${index}`);
  for (let ref = 0; ref < config.refsPerPage; ref += 1) {
    add("references", pageId(referenceTargetIndex(index, ref, config.n)), `u_ref_${index}_${ref}`);
  }
  return linkValue(leaves);
};

const pageRow = (config: BenchConfig, index: number): Entity =>
  row(pageId(index), "page", {
    title: leaf(`u_page_${index}_title`, `Document ${index} — a page in a very large workspace`),
    icon: leaf(`u_page_${index}_icon`, "📄"),
    updated_at: leaf(`u_page_${index}_updated_at`, UPDATED_AT_BASE + index),
    link: pageLink(config, index),
  });

const membershipRow = (index: number): Entity =>
  row(membershipRowId(index), "ebb", {
    membership: leaf(`u_${membershipRowId(index)}`, {
      entity_id: pageId(index),
      group_id: WORKSPACE_GROUP_ID,
    }),
  });

const groupRow = (): Entity =>
  row(WORKSPACE_GROUP_ID, "ebb", { group: leaf("u_grp_ws_name", { name: "Workspace" }) });

const bodyRow = (index: number, content: FieldValue): Entity =>
  row(bodyId(index), BODY_TYPE, { content });

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** The edges every page carries, which is what the traversal reads. */
const edgeCount = (config: BenchConfig): number =>
  Math.max(0, config.n - 1) + config.n * config.refsPerPage;

/**
 * The resident buckets, in load order: pages (each carrying its edge keys),
 * memberships, then the workspace group. `createResidentRows` and
 * `createWorkspace` both build from here so their id sets cannot drift apart.
 */
const residentRowSet = (config: BenchConfig) => {
  const pages = Array.from({ length: config.n }, (_, index) => pageRow(config, index));
  const memberships = Array.from({ length: config.n }, (_, index) => membershipRow(index));
  const groups = [groupRow()];
  return {
    pages,
    memberships,
    relationships: edgeCount(config),
    groups,
    rows: [...pages, ...memberships, ...groups],
  };
};

/**
 * Freshly allocated resident rows only, as `ReplicaRecord.entities` expects them.
 * The heap account needs its own row objects: the workspace record's rows are
 * shared with the store, so their bytes could not be attributed to the
 * benchmark's footprint. Same ids, count, and order as `createWorkspace`.
 */
export const createResidentRows = (config: BenchConfig): readonly Entity[] =>
  residentRowSet(config).rows;

export const createWorkspace = (config: BenchConfig): Workspace => {
  const content = bodyContent(config);
  const { pages, memberships, relationships, groups, rows: metadata } = residentRowSet(config);

  const bodyIndices = spreadIndices(config.n, BODY_DOCS);
  const bodies = bodyIndices.map((index) => bodyRow(index, content));

  // The record is the metadata base; a body is the store's to serve, which is
  // what makes a body read observable as a store read.
  const record: ReplicaRecord = {
    format: REPLICA_RECORD_FORMAT,
    componentVersions: {},
    position: 0,
    revision: 1,
    entities: [...metadata],
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
      relationships,
      memberships: memberships.length,
      groups: groups.length,
      residentRows: metadata.length,
      bodyRows: bodies.length,
    },
    bodyBytes: Buffer.byteLength(JSON.stringify(representative)),
  };
};

// ---------------------------------------------------------------------------
// Derived shape
// ---------------------------------------------------------------------------

/** A string field's value, or `undefined` for a map/absent/malformed field. */
export const stringField = (entity: Entity, name: string): string | undefined => {
  for (const kind of ["link", "membership", "group", "grant"] as const) {
    const value = systemValue(entity, kind);
    if (value !== null) {
      const entry = value[name];
      return typeof entry === "string" ? entry : undefined;
    }
  }
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
    // A link contributes one reverse entry per live edge, keyed on the edge and
    // yielding the row that carries it; forward traversal is a component read
    // of that row, so it adds no index entry.
    for (const edge of linkEdges(entity)) {
      reverse.add(JSON.stringify([edge.as, edge.type, edge.targetId]));
      reverseRows += 1;
    }
    const member = stringField(entity, "entity_id");
    const group = stringField(entity, "group_id");
    if (carriesComponent(entity, "membership") && member && group) {
      reverse.add(JSON.stringify(["groups", "ebb/membership", group]));
      forward.add(JSON.stringify(["groups", "ebb/membership", member]));
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
