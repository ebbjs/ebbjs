/**
 * Names the SDK reserves for its own surface: the platform namespace model
 * and the injected membership accessor. `defineModel` / `defineRelationship`
 * reject an app-authored collision at schema build time so the canonical
 * surface can't be shadowed.
 */

import {
  EBB_COMPONENT_KINDS,
  EBB_MODEL_NAME,
  ebbComponent,
  ebbComponentField,
  GROUPS_ACCESSOR,
} from "@ebbjs/core";

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
 * The row fields the platform's own components occupy. An `ebb/*` component may
 * sit on a row of any model (that is how a link lives on its source), and it
 * is stored at the field its name ends in, so an app field of the same name
 * would share `data.fields.<name>` with the overlay and be unreadable. Reserved
 * rather than merged: a component per field name is the rule that keeps one
 * value per name.
 */
export const RESERVED_PLATFORM_FIELDS = EBB_COMPONENT_KINDS.map((kind) =>
  ebbComponentField(kind),
) as readonly string[];

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
  ...RESERVED_PLATFORM_FIELDS.map(
    (name) =>
      [
        name,
        `\`${PLATFORM_NAMESPACE}/${name}\` is a platform component that may sit on any row`,
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
