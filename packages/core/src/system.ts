/**
 * The platform's own components.
 *
 * `ebb/` is the platform namespace. A row that carries only platform
 * components is committed under the model `ebb`; the *component* names the
 * row's kind. Four kinds, one atomic value each:
 *
 * | kind         | component        | value                                 |
 * | ------------ | ---------------- | ------------------------------------- |
 * | `group`      | `ebb/group`      | `{name, apps}`                        |
 * | `grant`      | `ebb/grant`      | `{actor_id, group_id, permissions}`   |
 * | `membership` | `ebb/membership` | `{entity_id, group_id}`               |
 * | `link`       | `ebb/link`       | `{source_id, target_id, type, field}` |
 *
 * Atomic means one Update carries the whole object, stored as one leaf at the
 * row field named after the kind (`data.fields.link`). So a torn edge,
 * membership, or grant is unrepresentable, and reading one is a read of the
 * component's value — never of four separate row fields.
 */

import { componentName, type Entity } from "./types";

/** The model every platform row is committed under. */
export const EBB_MODEL_NAME = "ebb";

/** The four platform components, as `<model>/<leaf>` names. */
export const EBB_COMPONENTS = Object.freeze({
  group: "ebb/group",
  grant: "ebb/grant",
  membership: "ebb/membership",
  link: "ebb/link",
} as const);

/** A platform component's kind. */
export type EbbComponentKind = keyof typeof EBB_COMPONENTS;

/** The kinds, in declaration order. */
export const EBB_COMPONENT_KINDS = Object.freeze(Object.keys(EBB_COMPONENTS) as EbbComponentKind[]);

/** The component name for one kind. */
export const ebbComponent = (kind: EbbComponentKind): string => EBB_COMPONENTS[kind];

/** The row field a kind's value is stored at (the leaf after the `/`). */
export const ebbComponentField = (kind: EbbComponentKind): string =>
  componentName(EBB_MODEL_NAME, kind).split("/")[1] as string;

const KINDS_BY_COMPONENT = new Map<string, EbbComponentKind>(
  EBB_COMPONENT_KINDS.map((kind) => [EBB_COMPONENTS[kind], kind]),
);

/** The kind a component name names, or `null` for a non-platform component. */
export const ebbComponentKind = (component: string): EbbComponentKind | null =>
  KINDS_BY_COMPONENT.get(component) ?? null;

/** Whether a component name belongs to the platform. */
export const isEbbComponent = (component: string): boolean => KINDS_BY_COMPONENT.has(component);

/** A component's value: the atomic object a platform row carries. */
export type SystemValue = Readonly<Record<string, unknown>>;

/**
 * The value a row carries for `kind`, or `null` when it does not carry it.
 *
 * Reads the component's leaf and returns its `value`, which is the whole
 * object. A tombstoned leaf, a missing field, and a row of another kind all
 * read as absent.
 */
export const systemValue = (
  row: Pick<Entity, "data"> | null | undefined,
  kind: EbbComponentKind,
): SystemValue | null => {
  const field = row?.data?.fields?.[ebbComponentField(kind)];
  if (field === undefined || field === null) return null;
  const value = (field as { value?: unknown }).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SystemValue;
};

/** Whether a row carries `kind`. */
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
