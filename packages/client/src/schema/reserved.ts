/**
 * Names the SDK reserves for its system entities, the injected
 * membership accessor, and the client's own sub-namespaces.
 * `defineEntity` / `defineRelationship` reject an app-authored
 * collision at schema build time so the canonical surface can't be
 * shadowed.
 */

/** Server-recognized system entity types; the client mirrors them. */
const SYSTEM_ENTITY_NAMES = ["group", "groupMember", "entityGroup", "relationship"] as const;

/**
 * Client sub-namespaces mounted on the client instance. `createClient`'s
 * proxy resolves an entity namespace before the instance field, so an
 * entity with one of these names would shadow the sub-namespace and
 * leave its surface unreachable. Reserve the name instead.
 */
const CLIENT_NAMESPACE_NAMES = ["snapshots"] as const;

/** Every entity name the SDK reserves. */
export const RESERVED_ENTITY_NAMES = [...SYSTEM_ENTITY_NAMES, ...CLIENT_NAMESPACE_NAMES] as const;

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

/** Reject a `defineEntity` name that collides with a system entity. */
export const assertEntityNameAvailable = (name: string): void => {
  if ((RESERVED_ENTITY_NAMES as readonly string[]).includes(name)) {
    throw new ReservedNameError(name, `Entity name "${name}" is reserved by the SDK`);
  }
};

/** Reject a `defineEntity` field name that collides with the membership accessor. */
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
