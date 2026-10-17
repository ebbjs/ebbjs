/**
 * THROWAWAY PERF SPIKE — read-model footprint and read cost at 10k documents.
 *
 * This is a benchmark/logic spike, not a UI prototype: no persistence, no
 * rendering, one command. It exists to settle epic ebbjs/ebbjs#495.
 *
 * Question: at a Notion-like 10k-document workspace, is a synchronous resident
 * read model (design C: normalized entity table + adjacency indices, sync
 * reads) justified over the current async, scan-per-accessor path — or should
 * the client stay async with query-scoped residency?
 *
 * It models a workspace the way ebb stores one:
 *   - `page` entities        — resident metadata (title, icon, updated_at)
 *   - `page_content` entities — heavy bodies (collaborative-text `content` map)
 *   - `relationship` rows     — one `parent` edge per page (the tree) and
 *                               `REFERENCES_PER_PAGE` `references` edges
 *   - `entityGroup` rows      — one membership per page
 *
 * It measures, against the REAL `@ebbjs/storage/memory` adapter and the REAL
 * traversal helpers from `packages/client/src/sync/relationship.ts`:
 *   1. JSON footprint of resident metadata vs heavy bodies vs full workspace,
 *   2. per-read cost of the current scan path vs the resident projection,
 *      counted in rows-scanned/cloned (not just wall-clock),
 *   3. the cost of building the page tree for the whole workspace on each path,
 *   4. the async microtask tax, isolated from the algorithmic scan cost.
 *
 * Prereq: `pnpm storage:build` once — tsx resolves `@ebbjs/storage/memory` from
 * `dist`, while `relationship.ts` is imported from `src`.
 * Run: pnpm --filter @ebbjs/client exec tsx spike/read-model-spike.ts
 * Env: N (docs, default 10000), SAMPLE (reads, default 25),
 *      BODY_BLOCKS (default 120), BODY_CHARS (default 200),
 *      BRANCH (default 10), REFS_PER_PAGE (default 2).
 *
 * PITFALLS this rewrite avoids (learned from the first attempt):
 *   - The memory adapter deep-clones every entity on get/query
 *     (`copyEntity` = JSON.parse(JSON.stringify(...))), so a full tree build
 *     is O(pages x relationship-rows) clones. We sample reads and extrapolate.
 *   - Do NOT `set` the heavy bodies into the adapter; they are only for the
 *     footprint number. Populating them (and their clones) blows the run up.
 *   - Prefer a counter over wall-clock for scan cost: we wrap `queryByType`
 *     and report rows scanned/cloned per traversal.
 *   - Populating the memory adapter is itself O(n^2) (every `set` spreads the
 *     whole entity record). We report that, exclude it from read timings, and
 *     never insert the entityGroup/bodies into the adapter.
 */
import { Type } from "@sinclair/typebox";
import type { Entity, FieldValue } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { forwardMany, forwardOne, reverse } from "../src/sync/relationship";

// ---------------------------------------------------------------------------
// Config (env-overridable)
// ---------------------------------------------------------------------------

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
};

const N = num("N", 10_000);
const SAMPLE = num("SAMPLE", 25);
const BODY_BLOCKS = num("BODY_BLOCKS", 120);
const BODY_CHARS = num("BODY_CHARS", 200);
const BRANCH = num("BRANCH", 10);
const REFS_PER_PAGE = num("REFS_PER_PAGE", 2);

const pageShape = Type.Object({ title: Type.String() });

const pageId = (i: number): string => `page_${i}`;
const bodyId = (i: number): string => `body_${i}`;
const parentOf = (i: number): number => Math.floor((i - 1) / BRANCH);

let entitySeq = 0;
const leaf = (value: unknown): FieldValue => ({ value, update_id: `u_${entitySeq++}` });
const mkEntity = (id: string, type: string, fields: Record<string, FieldValue>): Entity => ({
  id,
  type,
  data: { fields },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

// ---------------------------------------------------------------------------
// Generate the workspace
// ---------------------------------------------------------------------------

const pages: Entity[] = [];
const relationships: Entity[] = [];
const entityGroups: Entity[] = [];

for (let i = 0; i < N; i++) {
  pages.push(
    mkEntity(pageId(i), "page", {
      title: leaf(`Document ${i} — a page in a very large workspace`),
      icon: leaf("📄"),
      updated_at: leaf(1_700_000_000_000 + i),
    }),
  );
  entityGroups.push(
    mkEntity(`eg_${i}`, "entityGroup", {
      entity_id: leaf(pageId(i)),
      group_id: leaf("grp_ws"),
    }),
  );

  if (i > 0) {
    relationships.push(
      mkEntity(`rel_parent_${i}`, "relationship", {
        source_id: leaf(pageId(i)),
        target_id: leaf(pageId(parentOf(i))),
        type: leaf("page"),
        field: leaf("parent"),
      }),
    );
  }
  for (let r = 0; r < REFS_PER_PAGE; r++) {
    const target = (i * 7 + r * 13 + 1) % N;
    relationships.push(
      mkEntity(`rel_ref_${i}_${r}`, "relationship", {
        source_id: leaf(pageId(i)),
        target_id: leaf(pageId(target)),
        type: leaf("page"),
        field: leaf("references"),
      }),
    );
  }
}

const group = mkEntity("grp_ws", "group", { name: leaf("Workspace") });

// A representative heavy body: `BODY_BLOCKS` leaf blocks of ~`BODY_CHARS`
// chars. Entities share the template's (immutable) content map; the serialized
// bytes per entity are identical apart from the id, so the footprint is exact.
const blockText = "lorem ipsum dolor sit amet ".repeat(Math.ceil(BODY_CHARS / 27));
const bodyTemplate: FieldValue = {
  map: Object.fromEntries(
    Array.from({ length: BODY_BLOCKS }, (_, b) => [
      `block_${b}`,
      leaf(`${blockText} [block ${b}]`.slice(0, BODY_CHARS + 12)),
    ]),
  ),
};

// ---------------------------------------------------------------------------
// 1. Footprint (JSON bytes, uncompressed)
// ---------------------------------------------------------------------------

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const pageBytes = jsonBytes(pages);
const relationshipBytes = jsonBytes(relationships);
const groupBytes = jsonBytes(entityGroups) + jsonBytes(group);
const metadataBytes = pageBytes + relationshipBytes + groupBytes;

let bodyBytes = 0;
for (let i = 0; i < N; i++) {
  bodyBytes += jsonBytes(mkEntity(bodyId(i), "page_content", { content: bodyTemplate }));
}
const workspaceBytes = metadataBytes + bodyBytes;

// ---------------------------------------------------------------------------
// Current path: the real memory adapter + the real traversal functions
// ---------------------------------------------------------------------------

process.stderr.write(
  `[spike] populating the real memory adapter with ${(
    pages.length + relationships.length
  ).toLocaleString()} entities (metadata only; O(n^2) in the adapter's write path)...\n`,
);

const adapter = createMemoryAdapter();
const populateStart = performance.now();
const toInsert = [...pages, ...relationships];
for (let i = 0; i < toInsert.length; i++) {
  await adapter.entities.set(toInsert[i]!);
  if (i > 0 && i % 5_000 === 0) {
    process.stderr.write(
      `[spike]   inserted ${i.toLocaleString()} / ${toInsert.length.toLocaleString()}\n`,
    );
  }
}
const populateMs = performance.now() - populateStart;
process.stderr.write(`[spike] adapter populated in ${(populateMs / 1000).toFixed(1)} s\n`);

// Counters: the primary scan-cost metric. `rows` counts entities returned by
// `query`, which is also the number of deep clones the adapter performs.
let queryCalls = 0;
let rowsScanned = 0;
let getCalls = 0;

const readEntity = (id: string): Promise<Entity | null> => {
  getCalls++;
  return adapter.entities.get(id);
};
const queryByType = (type: string): Promise<readonly Entity[]> => {
  queryCalls++;
  return adapter.entities.query(type).then((rows) => {
    rowsScanned += rows.length;
    return rows;
  });
};
const resetCounters = (): void => {
  queryCalls = 0;
  rowsScanned = 0;
  getCalls = 0;
};

// Sample pages spread across the id space so traversals hit the whole index.
const sampleIds = Array.from({ length: SAMPLE }, (_, k) =>
  pageId(Math.floor(((k + 0.5) * N) / SAMPLE)),
);

interface SampleStats {
  readonly perCallMs: number;
  readonly perCallRows: number;
  readonly perCallQueries: number;
  readonly perCallGets: number;
  readonly totalMs: number;
}
type ReadFn = (id: string) => Promise<unknown>;

const sampleRead = async (fn: ReadFn): Promise<SampleStats> => {
  resetCounters();
  const start = performance.now();
  for (const id of sampleIds) await fn(id);
  const totalMs = performance.now() - start;
  return {
    perCallMs: totalMs / SAMPLE,
    perCallRows: rowsScanned / SAMPLE,
    perCallQueries: queryCalls / SAMPLE,
    perCallGets: getCalls / SAMPLE,
    totalMs,
  };
};

// Self-check: the real traversal returns the shape the spike assumes.
const rootChildren = await reverse(
  readEntity,
  queryByType,
  pageId(0),
  "page",
  pageShape,
  "parent",
  "page",
);
const expectedRootChildren = Math.min(BRANCH, Math.max(0, N - 1));
if (rootChildren.length !== expectedRootChildren) {
  throw new Error(
    `spike self-check: expected ${expectedRootChildren} children of page_0, got ${rootChildren.length}`,
  );
}
const rootOfFirst = await forwardOne(readEntity, queryByType, pageId(1), "page", "parent", "page");
if (rootOfFirst?.id !== pageId(0)) {
  throw new Error(`spike self-check: parent of page_1 is ${rootOfFirst?.id}, expected page_0`);
}

const currentChildren = await sampleRead((id) =>
  reverse(readEntity, queryByType, id, "page", pageShape, "parent", "page"),
);
const currentParent = await sampleRead((id) =>
  forwardOne(readEntity, queryByType, id, "page", "parent", "page"),
);
const currentBacklinks = await sampleRead((id) =>
  reverse(readEntity, queryByType, id, "page", pageShape, "references", "page"),
);
const currentForwardMany = await sampleRead((id) =>
  forwardMany(readEntity, queryByType, id, "page", "page", pageShape, "references", "page"),
);

// Search: one full scan of every page.
resetCounters();
const currentSearchStart = performance.now();
const currentSearchRows = await queryByType("page");
currentSearchRows.filter((row) =>
  String(row.data?.fields?.["title"]?.value).includes("Document 4"),
);
const currentSearchMs = performance.now() - currentSearchStart;
const currentSearchRowsScanned = rowsScanned;

// ---------------------------------------------------------------------------
// Existing async storage index (`queryByRelationship`) — ships today, unused
// by the client's relationship accessors. Reverse-direction reads only.
// ---------------------------------------------------------------------------

const indexChildren = async (id: string): Promise<readonly string[]> =>
  adapter.entities.queryByRelationship({ as: "parent", type: "page", targetId: id });
const indexBacklinks = async (id: string): Promise<readonly string[]> =>
  adapter.entities.queryByRelationship({ as: "references", type: "page", targetId: id });

resetCounters();
const indexChildrenStart = performance.now();
for (const id of sampleIds) await indexChildren(id);
const indexChildrenMs = (performance.now() - indexChildrenStart) / SAMPLE;

resetCounters();
const indexBacklinksStart = performance.now();
for (const id of sampleIds) await indexBacklinks(id);
const indexBacklinksMs = (performance.now() - indexBacklinksStart) / SAMPLE;

// ---------------------------------------------------------------------------
// Proposed path: a normalized resident projection with adjacency indices (C)
// ---------------------------------------------------------------------------

interface Projection {
  readonly byId: Map<string, Entity>;
  readonly pageIds: readonly string[];
  readonly parent: Map<string, string>;
  readonly children: Map<string, string[]>;
  readonly backlinks: Map<string, string[]>;
  readonly references: Map<string, string[]>;
  readonly groups: Map<string, string[]>;
}

const buildProjection = (): Projection => {
  const byId = new Map<string, Entity>();
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const references = new Map<string, string[]>();
  const groups = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };

  const indexRow = (entity: Entity): void => {
    byId.set(entity.id, entity);
    if (entity.type !== "relationship") {
      if (entity.type === "entityGroup") {
        const entityId = entity.data?.fields?.["entity_id"]?.value;
        const groupId = entity.data?.fields?.["group_id"]?.value;
        if (typeof entityId === "string" && typeof groupId === "string")
          push(groups, entityId, groupId);
      }
      return;
    }
    const source = entity.data?.fields?.["source_id"]?.value;
    const target = entity.data?.fields?.["target_id"]?.value;
    const field = entity.data?.fields?.["field"]?.value;
    if (typeof source !== "string" || typeof target !== "string") return;
    if (field === "parent") {
      parent.set(source, target);
      push(children, target, source);
    } else if (field === "references") {
      push(backlinks, target, source);
      push(references, source, target);
    }
  };

  for (const entity of [...pages, ...relationships, ...entityGroups, group]) indexRow(entity);
  return {
    byId,
    pageIds: pages.map((p) => p.id),
    parent,
    children,
    backlinks,
    references,
    groups,
  };
};

const projectionBuildStart = performance.now();
const projection = buildProjection();
const projectionBuildMs = performance.now() - projectionBuildStart;

// Cross-check the projection agrees with the real traversal.
for (const id of sampleIds.slice(0, Math.min(5, sampleIds.length))) {
  const viaProjection = projection.children.get(id)?.length ?? 0;
  const viaAdapter = (
    await reverse(readEntity, queryByType, id, "page", pageShape, "parent", "page")
  ).length;
  if (viaProjection !== viaAdapter) {
    throw new Error(
      `spike self-check: children mismatch for ${id}: projection ${viaProjection} vs adapter ${viaAdapter}`,
    );
  }
}

const residentReadMs = (fn: (id: string) => unknown): number => {
  const start = performance.now();
  for (const id of sampleIds) fn(id);
  return (performance.now() - start) / SAMPLE;
};

const residentChildrenMs = residentReadMs((id) => projection.children.get(id));
const residentParentMs = residentReadMs((id) => projection.parent.get(id));
const residentBacklinksMs = residentReadMs((id) => projection.backlinks.get(id));
const residentForwardManyMs = residentReadMs((id) => projection.references.get(id));

const residentSearchStart = performance.now();
pages.filter((row) => String(row.data?.fields?.["title"]?.value).includes("Document 4"));
const residentSearchMs = performance.now() - residentSearchStart;

// ---------------------------------------------------------------------------
// 3. Full page-tree build for all N pages
// ---------------------------------------------------------------------------

// Current path is extrapolated: running N reverse traversals would clone
// O(N x relationship-rows) entities and is the blow-up the spike exists to
// quantify. Do NOT run it.
const currentTreeRows = currentChildren.perCallRows * N;
const currentTreeMs = currentChildren.perCallMs * N;

// Storage index: N reverse index reads to collect each page's child ids, plus
// one `get` per page to resolve node metadata.
const indexTreeStart = performance.now();
for (let i = 0; i < N; i++) await indexChildren(pageId(i));
for (let i = 0; i < N; i++) await adapter.entities.get(pageId(i));
const indexTreeMs = performance.now() - indexTreeStart;

// Resident: build once, then walk the adjacency maps.
const residentTreeStart = performance.now();
const tree = new Map<string, readonly string[]>();
for (let i = 0; i < N; i++) tree.set(pageId(i), projection.children.get(pageId(i)) ?? []);
const residentTreeMs = performance.now() - residentTreeStart;
const residentTreeTotalMs = projectionBuildMs + residentTreeMs;

// ---------------------------------------------------------------------------
// 4. Async microtask tax, isolated from algorithmic cost
// ---------------------------------------------------------------------------

const hotId = pageId(Math.floor(N / 2));
const hotEntity = projection.byId.get(hotId);

const asyncTaxStart = performance.now();
for (let i = 0; i < N; i++) await adapter.entities.get(hotId);
const asyncGetMs = performance.now() - asyncTaxStart;

const syncTaxStart = performance.now();
for (let i = 0; i < N; i++) projection.byId.get(hotId);
const syncGetMs = performance.now() - syncTaxStart;

const microtaskStart = performance.now();
for (let i = 0; i < N; i++) await Promise.resolve();
const microtaskMs = performance.now() - microtaskStart;

// ---------------------------------------------------------------------------
// Report (Markdown on stdout)
// ---------------------------------------------------------------------------

const pct = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(1)}%`;
const secs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(1)} ms`;
const nsPerOp = (ms: number, ops: number): string => `${((ms * 1e6) / ops).toFixed(0)} ns/op`;

const footprintRows: readonly (readonly [string, number, number])[] = [
  ["`page` entities (title, icon, updated_at)", pages.length, pageBytes],
  ["`relationship` rows (parent + references)", relationships.length, relationshipBytes],
  ["`entityGroup` rows + group", entityGroups.length + 1, groupBytes],
  [
    "**resident metadata subtotal**",
    pages.length + relationships.length + entityGroups.length + 1,
    metadataBytes,
  ],
  ["`page_content` bodies (heavy)", N, bodyBytes],
  [
    "**full workspace**",
    pages.length * 2 + relationships.length + entityGroups.length + 1,
    workspaceBytes,
  ],
];

const perReadRow = (
  read: string,
  rows: number,
  queries: number,
  gets: number,
  ms: number,
): string =>
  `| ${read} | ${rows.toLocaleString()} | ${queries.toFixed(1)} | ${gets.toFixed(1)} | ${ms.toFixed(3)} |`;

const out: string[] = [];
out.push(`# Read-model spike — ${N.toLocaleString()} documents`);
out.push("");
out.push(
  `_Throwaway perf spike (not a UI prototype). Real \`createMemoryAdapter()\` + real \`forwardOne\`/\`reverse\`/\`forwardMany\` from \`packages/client/src/sync/relationship.ts\`. SAMPLE=${SAMPLE}, BRANCH=${BRANCH}, REFS_PER_PAGE=${REFS_PER_PAGE}, BODY_BLOCKS=${BODY_BLOCKS}, BODY_CHARS=${BODY_CHARS}._`,
);
out.push("");
out.push("## 1. Footprint");
out.push("");
out.push("| bucket | rows | JSON bytes | size | % of workspace |");
out.push("| --- | ---: | ---: | ---: | ---: |");
for (const [label, rows, bytes] of footprintRows) {
  out.push(
    `| ${label} | ${rows.toLocaleString()} | ${bytes.toLocaleString()} | ${mb(bytes)} | ${pct(bytes, workspaceBytes)} |`,
  );
}
out.push("");
out.push(
  `Hypothesis (resident metadata ~10–30 MB vs full workspace hundreds of MB): ${
    metadataBytes <= 30 * 1024 * 1024 && workspaceBytes > 100 * 1024 * 1024
      ? "**CONFIRMED**"
      : "**CHECK NUMBERS**"
  } — metadata is ${mb(metadataBytes)} (${pct(metadataBytes, workspaceBytes)} of the workspace); heavy bodies are ${mb(bodyBytes)}.`,
);
out.push("");
out.push("## 2. Per-read cost");
out.push("");
out.push(
  "Rows scanned = entities returned by `queryEntitiesByType` (each is one deep clone in the memory adapter). Avg per call over SAMPLE reads; search is a single full scan.",
);
out.push("");
out.push("| read | rows scanned | query calls | get calls | ms/call |");
out.push("| --- | ---: | ---: | ---: | ---: |");
out.push(
  perReadRow(
    "children via `reverse` (current, async scan)",
    currentChildren.perCallRows,
    currentChildren.perCallQueries,
    currentChildren.perCallGets,
    currentChildren.perCallMs,
  ),
);
out.push(
  perReadRow(
    "parent via `forwardOne` (current, async scan)",
    currentParent.perCallRows,
    currentParent.perCallQueries,
    currentParent.perCallGets,
    currentParent.perCallMs,
  ),
);
out.push(
  perReadRow(
    "backlinks via `reverse` (current, async scan)",
    currentBacklinks.perCallRows,
    currentBacklinks.perCallQueries,
    currentBacklinks.perCallGets,
    currentBacklinks.perCallMs,
  ),
);
out.push(
  perReadRow(
    "references via `forwardMany` (current, async scan)",
    currentForwardMany.perCallRows,
    currentForwardMany.perCallQueries,
    currentForwardMany.perCallGets,
    currentForwardMany.perCallMs,
  ),
);
out.push(
  perReadRow(
    "search all pages (current, async scan)",
    currentSearchRowsScanned,
    1,
    0,
    currentSearchMs,
  ),
);
out.push(perReadRow("children via resident `Map` (C, sync)", 0, 0, 0, residentChildrenMs));
out.push(perReadRow("parent via resident `Map` (C, sync)", 0, 0, 0, residentParentMs));
out.push(perReadRow("backlinks via resident `Map` (C, sync)", 0, 0, 0, residentBacklinksMs));
out.push(perReadRow("references via resident `Map` (C, sync)", 0, 0, 0, residentForwardManyMs));
out.push(perReadRow("search all pages (resident, sync)", N, 0, 0, residentSearchMs));
out.push("");
out.push(
  "### Reverse reads via the async storage index that already ships (`queryByRelationship`)",
);
out.push("");
out.push("| read | rows cloned | ms/call |");
out.push("| --- | ---: | ---: |");
out.push(`| children (reverse index) | 0 (returns ids) | ${indexChildrenMs.toFixed(4)} |`);
out.push(`| backlinks (reverse index) | 0 (returns ids) | ${indexBacklinksMs.toFixed(4)} |`);
out.push("");
out.push("## 3. Full page-tree build (all pages)");
out.push("");
out.push("| path | work | wall-clock |");
out.push("| --- | --- | ---: |");
out.push(
  `| current async scan | ${currentTreeRows.toLocaleString()} rows cloned (extrapolated from ${SAMPLE} sampled \`reverse\` reads; NOT run) | ${secs(currentTreeMs)} (extrapolated) |`,
);
out.push(
  `| async storage index + N gets | N \`queryByRelationship\` reads + N \`get\`s | ${secs(indexTreeMs)} (measured) |`,
);
out.push(
  `| resident projection (C) | build adjacency (${projectionBuildMs.toFixed(1)} ms) + N \`Map.get\` (${residentTreeMs.toFixed(1)} ms) | ${secs(residentTreeTotalMs)} (measured) |`,
);
out.push("");
out.push("## 4. Async microtask tax (isolated)");
out.push("");
out.push("| loop | total | per op |");
out.push("| --- | ---: | ---: |");
out.push(
  `| \`await adapter.entities.get(hot)\` x ${N.toLocaleString()} | ${asyncGetMs.toFixed(1)} ms | ${nsPerOp(asyncGetMs, N)} |`,
);
out.push(
  `| \`projection.byId.get(hot)\` x ${N.toLocaleString()} | ${syncGetMs.toFixed(1)} ms | ${nsPerOp(syncGetMs, N)} |`,
);
out.push(
  `| \`await Promise.resolve()\` x ${N.toLocaleString()} | ${microtaskMs.toFixed(1)} ms | ${nsPerOp(microtaskMs, N)} |`,
);
out.push("");
out.push("## Deciding numbers");
out.push("");
out.push(
  `- Resident metadata: **${mb(metadataBytes)}**; full workspace: **${mb(workspaceBytes)}** (bodies are ${(bodyBytes / metadataBytes).toFixed(1)}x metadata).`,
);
out.push(
  `- One children read: current **${currentChildren.perCallMs.toFixed(1)} ms** / **${currentChildren.perCallRows.toLocaleString()} rows cloned** vs resident **${(residentChildrenMs * 1000).toFixed(1)} µs** / 0 rows.`,
);
out.push(
  `- Full page tree for ${N.toLocaleString()} pages: current **${secs(currentTreeMs)}** (extrapolated, ${currentTreeRows.toLocaleString()} clones) vs storage-index **${secs(indexTreeMs)}** vs resident **${secs(residentTreeTotalMs)}**.`,
);
out.push(
  `- Promise tax per await: **${nsPerOp(microtaskMs, N)}**; per hot \`get\`: **${nsPerOp(asyncGetMs, N)}**. The current tree cost is **${(currentTreeMs / Math.max(microtaskMs, 0.001)).toFixed(0)}x** the entire microtask tax of the same N awaits — the cost is algorithmic, not promises.`,
);
out.push(
  `- Projection build (one pass over metadata): **${projectionBuildMs.toFixed(1)} ms**. Adapter population excluded (memory-adapter write path is O(n²)): **${secs(populateMs)}** for ${toInsert.length.toLocaleString()} entities — not a read cost.`,
);
out.push(
  `- \`hotEntity\` resolved synchronously for reference: ${hotEntity === undefined ? "missing" : hotEntity.id}.`,
);
out.push("");

process.stdout.write(out.join("\n"));
