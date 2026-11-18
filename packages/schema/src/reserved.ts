/**
 * Names the SDK reserves for its own surface: the platform namespace model
 * and the injected membership accessor. `defineModel` / `defineRelationship`
 * reject an app-authored collision at schema build time so the canonical
 * surface can't be shadowed.
 */

import { EBB_MODEL_NAME, EBB_OVERLAY_KIND, ebbComponentField, GROUPS_ACCESSOR } from "@ebbjs/core";

/**
 * The namespace the platform's own components live under. An app may not declare
 * it: a component's namespace is its permission subject, so claiming it would let
 * an app mint the platform's permissions.
 */
export const PLATFORM_NAMESPACE = EBB_MODEL_NAME;

/**
 * The injected membership accessor. Also reserved as an entity field
 * name: the row accessor would otherwise shadow the projected field.
 */
export const RESERVED_MEMBERSHIP_NAMES = [GROUPS_ACCESSOR] as const;

/**
 * The row fields the platform's overlays occupy. `ebb/link` is the one platform
 * component that sits on a row of another model (its source), and it is stored
 * at the field its name ends in, so an app field of that name would share
 * `data.fields.<field>` with the edge map and be unreadable. The other platform
 * components are rows of their own, so their field names stay free on a user
 * model. Reserved rather than merged: a component per field name is the rule
 * that keeps one value per name.
 */
export const RESERVED_OVERLAY_FIELDS = [ebbComponentField(EBB_OVERLAY_KIND)] as const;

/**
 * Model names the SDK reserves. `group` and `membership` are what `client.group`
 * and `client.membership` are keyed by, so an app model of either name would
 * shadow a namespace the SDK injects.
 */
export const RESERVED_MODEL_NAMES = [PLATFORM_NAMESPACE, "group", "membership"] as const;

/** Raised when an app declares a name the SDK reserves. */
export class ReservedNameError extends Error {
  /** The reserved name the caller collided with. */
  readonly reserved: string;

  constructor(reserved: string, message: string) {
    super(message);
    this.name = "ReservedNameError";
    this.reserved = reserved;
  }
}

/** Reject a `defineModel` name the SDK's own surface already answers to. */
export const assertEntityNameAvailable = (name: string): void => {
  if (!(RESERVED_MODEL_NAMES as readonly string[]).includes(name)) return;

  const why =
    name === PLATFORM_NAMESPACE
      ? `the \`${PLATFORM_NAMESPACE}/\` namespace holds the platform's own components`
      : `the SDK's built-in \`client.${name}\` namespace answers to it`;

  throw new ReservedNameError(name, `Entity name "${name}" is reserved: ${why}.`);
};

/** Reject a `defineModel` field name the platform's own components occupy. */
export const assertFieldNamesAvailable = (
  entityName: string,
  fields: Record<string, unknown>,
): void => {
  for (const [name, reason] of fieldReservations()) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
    throw new ReservedNameError(
      name,
      `Field "${name}" on entity "${entityName}" is reserved: ${reason}`,
    );
  }
};

/** Every reserved field name, with why claiming it fails. */
const fieldReservations = (): readonly (readonly [string, string])[] => [
  ...RESERVED_MEMBERSHIP_NAMES.map(
    (name) => [name, "the SDK's built-in membership accessor projects onto it"] as const,
  ),
  ...RESERVED_OVERLAY_FIELDS.map(
    (name) =>
      [
        name,
        `\`${PLATFORM_NAMESPACE}/${name}\` is a platform overlay that may sit on any row`,
      ] as const,
  ),
];

/** Reject a `defineRelationship` accessor that collides with the membership accessor. */
export const assertAccessorNameAvailable = (sourceName: string, as: string): void => {
  if ((RESERVED_MEMBERSHIP_NAMES as readonly string[]).includes(as)) {
    throw new ReservedNameError(
      as,
      `Relationship accessor "${as}" on entity "${sourceName}" is reserved by the SDK`,
    );
  }
};
