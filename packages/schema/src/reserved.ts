/**
 * Names the SDK reserves for its own surface: the platform namespace model
 * and the injected membership accessor. `defineModel` / `defineRelationship`
 * reject an app-authored collision at schema build time so the canonical
 * surface can't be shadowed.
 */

import { EBB_MODEL_NAME } from "@ebbjs/core";

/**
 * The model namespace the platform's own components live under (`ebb/group`,
 * `ebb/grant`, `ebb/membership`, `ebb/link`). An app may not declare a model
 * with this name: a component's namespace is its permission subject, so
 * claiming it would let an app mint the platform's permissions.
 */
export const PLATFORM_NAMESPACE = EBB_MODEL_NAME;

/**
 * The injected membership accessor. Also reserved as an entity field
 * name: the row accessor would otherwise shadow the projected field.
 */
export const RESERVED_MEMBERSHIP_NAMES = ["groups"] as const;

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

/** Reject a `defineModel` name that claims the platform namespace. */
export const assertEntityNameAvailable = (name: string): void => {
  if (name === PLATFORM_NAMESPACE) {
    throw new ReservedNameError(
      name,
      `Entity name "${name}" is reserved: the \`${PLATFORM_NAMESPACE}/\` namespace holds the ` +
        `platform's own components.`,
    );
  }
};

/** Reject a `defineModel` field name that collides with the membership accessor. */
export const assertFieldNamesAvailable = (
  entityName: string,
  fields: Record<string, unknown>,
): void => {
  for (const name of RESERVED_MEMBERSHIP_NAMES) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new ReservedNameError(
        name,
        `Field "${name}" on entity "${entityName}" is reserved by the SDK`,
      );
    }
  }
};

/** Reject a `defineRelationship` accessor that collides with the membership accessor. */
export const assertAccessorNameAvailable = (sourceName: string, as: string): void => {
  if ((RESERVED_MEMBERSHIP_NAMES as readonly string[]).includes(as)) {
    throw new ReservedNameError(
      as,
      `Relationship accessor "${as}" on entity "${sourceName}" is reserved by the SDK`,
    );
  }
};
