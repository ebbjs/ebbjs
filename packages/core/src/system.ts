/**
 * The platform's own components.
 *
 * `ebb/` is the platform namespace, and a row that carries only platform
 * components is committed under the model `ebb`. Three kinds are an atomic
 * value on a row of their own:
 *
 * | kind         | component        | value                               |
 * | ------------ | ---------------- | ----------------------------------- |
 * | `group`      | `ebb/group`      | `{name, apps}`                      |
 * | `grant`      | `ebb/grant`      | `{actor_id, group_id, permissions}` |
 * | `membership` | `ebb/membership` | `{entity_id, group_id}`             |
 *
 * Atomic means one Update carries the whole object, stored as one leaf at
 * `data.fields.<kind>`: a torn membership or grant is unrepresentable.
 *
 * `ebb/link` is the fourth kind and not a row kind: it is a **keyed component
 * of its source row**, whose value is `{<as>: {<type>: {<target_id>: true}}}`.
 * The three nesting levels are the edge's key, so two edges under different
 * accessors or type labels are distinct and one Update writes one edge. A
 * present edge's leaf is `{value: true}`; removing one edge tombstones that key
 * with `{value: null}`. Read it with {@link linkEdges} / {@link linkTargets},
 * never with {@link systemValue}, which speaks only for the atomic kinds.
 */

import {
  componentName,
  isFieldMap,
  type ComponentName,
  type Entity,
  type FieldValue,
} from "./types";

export const EBB_MODEL_NAME = "ebb";

/**
 * The accessor the injected membership surface carries on every row: the
 * synthetic relationship name a query addresses membership by, and the field
 * name that surface is projected onto. Reserved, so no app model, relationship
 * accessor, or component may answer to it — the platform's membership index
 * owns the name.
 */
export const GROUPS_ACCESSOR = "groups";

/** The four platform components, as `<model>/<leaf>` names. */
const COMPONENTS_BY_KIND = Object.freeze({
  group: "ebb/group",
  grant: "ebb/grant",
  membership: "ebb/membership",
  link: "ebb/link",
} as const);

/** The same table, keyed by kind, under the name the public API has always used. */
export const EBB_COMPONENTS = COMPONENTS_BY_KIND;

export type EbbComponentKind = keyof typeof COMPONENTS_BY_KIND;

export const EBB_COMPONENT_KINDS = Object.freeze(
  Object.keys(COMPONENTS_BY_KIND) as EbbComponentKind[],
);

export const ebbComponent = (kind: EbbComponentKind): ComponentName => COMPONENTS_BY_KIND[kind];

/** The row field a kind's value is stored at: the leaf after the `/`. */
export const ebbComponentField = (kind: EbbComponentKind): string =>
  componentName(EBB_MODEL_NAME, kind).split("/")[1] as string;

const KINDS_BY_COMPONENT = new Map<string, EbbComponentKind>(
  EBB_COMPONENT_KINDS.map((kind) => [ebbComponent(kind), kind]),
);

/** The kind a component name names, or `null` for a non-platform component. */
export const ebbComponentKind = (component: string): EbbComponentKind | null =>
  KINDS_BY_COMPONENT.get(component) ?? null;

export const isEbbComponent = (component: string): boolean => KINDS_BY_COMPONENT.has(component);

/** A component's value: the atomic object a platform row carries. */
export type SystemValue = Readonly<Record<string, unknown>>;

/** The whole value an atomic component's leaf carries, or `null`. A leaf is `{value, update_id, hlc}`. */
export const componentValue = (leaf: FieldValue | null | undefined): SystemValue | null => {
  if (leaf === null || leaf === undefined) return null;
  const value = (leaf as { value?: unknown }).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SystemValue;
};

/**
 * The value a row carries for an atomic `kind`, or `null` for a missing field
 * or another kind. A keyed component has no whole value: `ebb/link` answers
 * `null` here by construction, and is read with {@link linkEdges}.
 */
export const systemValue = (
  row: Pick<Entity, "data"> | null | undefined,
  kind: EbbComponentKind,
): SystemValue | null =>
  componentValue(row?.data?.fields?.[ebbComponentField(kind)] as FieldValue | undefined);

/** Whether the row carries an atomic `kind`. Keyed components answer `false`; see {@link carriesLink}. */
export const carriesComponent = (
  row: Pick<Entity, "data"> | null | undefined,
  kind: EbbComponentKind,
): boolean => systemValue(row, kind) !== null;

/** One field of a row's `kind` value, or `null` when either is absent. */
export const systemValueField = (
  row: Pick<Entity, "data"> | null | undefined,
  kind: EbbComponentKind,
  field: string,
): unknown => systemValue(row, kind)?.[field] ?? null;

/** The string field of a row's `kind` value, or `null` when it is not a string. */
export const systemValueString = (
  row: Pick<Entity, "data"> | null | undefined,
  kind: EbbComponentKind,
  field: string,
): string | null => {
  const value = systemValueField(row, kind, field);
  return typeof value === "string" ? value : null;
};

/**
 * Any row carrying wire field values: a committed `Entity` and a `GET
 * /entities/:id` response both are one, which is why the link readers speak
 * this shape rather than the store's.
 */
export interface WireRow {
  readonly data: { readonly fields: Record<string, unknown> };
}

/** One live edge: the accessor, the wire type label, and the target row id. */
export interface LinkEdge {
  readonly as: string;
  readonly type: string;
  readonly targetId: string;
}

/** The `ebb/link` component's raw value, or `undefined` when the row carries none. */
const linkValue = (row: WireRow | null | undefined): FieldValue | undefined =>
  row?.data?.fields?.[ebbComponentField("link")] as FieldValue | undefined;

/** The nested map at `keys`, or `null` when the path is missing or is a leaf. */
const linkMapAt = (
  value: FieldValue | undefined,
  keys: readonly string[],
): Record<string, FieldValue> | null => {
  let current: FieldValue | undefined = value;
  for (const key of keys) {
    if (current === undefined || !isFieldMap(current)) return null;
    current = current.map[key];
  }
  return current !== undefined && isFieldMap(current) ? current.map : null;
};

/**
 * Whether a link leaf names a present edge. Presence is `true`; a tombstone is
 * `null`, and anything else is not an edge this reader can name.
 */
const isPresentLinkLeaf = (leaf: FieldValue | undefined): boolean =>
  leaf !== undefined && !isFieldMap(leaf) && leaf.value === true;

/** Ascending by as, then type, then target id: the order every replica reads. */
const compareLinks = (left: LinkEdge, right: LinkEdge): number => {
  if (left.as !== right.as) return left.as < right.as ? -1 : 1;
  if (left.type !== right.type) return left.type < right.type ? -1 : 1;
  if (left.targetId === right.targetId) return 0;
  return left.targetId < right.targetId ? -1 : 1;
};

/**
 * Every live edge the row's `ebb/link` component carries, in a stable order.
 * Tombstoned keys are absent, so a removal leaves nothing to read.
 */
export const linkEdges = (row: WireRow | null | undefined): readonly LinkEdge[] => {
  const edges: LinkEdge[] = [];
  const byAs = linkMapAt(linkValue(row), []);
  if (byAs === null) return edges;
  for (const [as, byType] of Object.entries(byAs)) {
    if (!isFieldMap(byType)) continue;
    for (const [type, byTarget] of Object.entries(byType.map)) {
      if (!isFieldMap(byTarget)) continue;
      for (const [targetId, leaf] of Object.entries(byTarget.map)) {
        if (isPresentLinkLeaf(leaf)) edges.push({ as, type, targetId });
      }
    }
  }
  return edges.sort(compareLinks);
};

/** Whether the row carries an `ebb/link` component at all, even a tombstoned one. */
export const carriesLink = (row: WireRow | null | undefined): boolean =>
  linkValue(row) !== undefined;

/** The live target ids of one `(as, type)`, ascending. */
export const linkTargets = (
  row: WireRow | null | undefined,
  as: string,
  type: string,
): readonly string[] => {
  const targets = linkMapAt(linkValue(row), [as, type]);
  if (targets === null) return [];
  return Object.entries(targets)
    .filter(([, leaf]) => isPresentLinkLeaf(leaf))
    .map(([targetId]) => targetId)
    .sort();
};

/** The platform kind whose value lives at each platform field name. */
const KIND_BY_FIELD: ReadonlyMap<string, EbbComponentKind> = new Map(
  EBB_COMPONENT_KINDS.map((kind) => [ebbComponentField(kind), kind]),
);

/**
 * The component a row's `field` is named under.
 *
 * `ebb/` is the platform's namespace, not the row's: an `ebb/*` component may
 * sit on a row of any model and never takes that row's model as its namespace,
 * so a platform field name is always `ebb/<field>`. Every other field is a
 * component of the row's own model. The one way to name a component, so a
 * reader and an index cannot disagree about where an overlay lives.
 */
export const fieldComponent = (model: string, field: string): ComponentName => {
  const kind = model === EBB_MODEL_NAME ? undefined : KIND_BY_FIELD.get(field);
  return kind === undefined ? componentName(model, field) : ebbComponent(kind);
};
