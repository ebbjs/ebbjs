/**
 * Read migrations at the projection seam (#804). The replica records the
 * version a value was materialized at; projection moves it to the declaration.
 */

import type { MigrationRegistry } from "@ebbjs/schema";
import type { ModelRegistry } from "@ebbjs/schema";

/** Raised when a stored component is newer than the client's declaration. */
export class ComponentVersionAheadError extends Error {
  readonly component: string;
  readonly stored: number;
  readonly declared: number;

  constructor(component: string, stored: number, declared: number) {
    super(
      `Component "${component}" is stored at version ${stored}, but this client declares ` +
        `version ${declared}. A newer client wrote data this schema cannot read: upgrade ` +
        `the client instead of reading it as the older shape.`,
    );
    this.name = "ComponentVersionAheadError";
    this.component = component;
    this.stored = stored;
    this.declared = declared;
  }
}

/** The read-time version bridge the projection helpers consult. */
export interface ComponentMigrations {
  /**
   * Move a stored component value to the declared version. Throws
   * {@link ComponentVersionAheadError} when the value is newer.
   */
  project(entityId: string, component: string, value: unknown): unknown;
}

export interface ComponentMigrationOptions {
  readonly registry: ModelRegistry;
  readonly migrations: MigrationRegistry;
  /** The version the replica materialized the component at; absent means current. */
  readonly versionOf?: (entityId: string, component: string) => number | undefined;
}

/** Build the projection-time migration bridge for one client. */
export const createComponentMigrations = (opts: ComponentMigrationOptions): ComponentMigrations => {
  const memo = new Map<string, WeakMap<object, unknown>>();
  const declaredByComponent = new Map<string, number>();
  const declaredVersion = (component: string): number => {
    const cached = declaredByComponent.get(component);
    if (cached !== undefined) return cached;
    const declared = opts.registry.versionOf(component);
    declaredByComponent.set(component, declared);
    return declared;
  };
  return {
    project(entityId, component, value) {
      const declared = declaredVersion(component);
      const stored = opts.versionOf?.(entityId, component) ?? declared;
      if (stored === declared) return value;
      if (stored > declared) throw new ComponentVersionAheadError(component, stored, declared);
      if (!opts.migrations.has(component)) return value;

      const key = `${component}\u0000${stored}\u0000${declared}`;
      let cache = memo.get(key);
      if (cache === undefined) {
        cache = new WeakMap();
        memo.set(key, cache);
      }
      if (typeof value === "object" && value !== null) {
        const cached = cache.get(value);
        if (cached !== undefined) return cached;
        const migrated = opts.migrations.migrate(component, stored, declared, value);
        if (typeof migrated === "object" && migrated !== null) cache.set(value, migrated);
        return migrated;
      }
      return opts.migrations.migrate(component, stored, declared, value);
    },
  };
};
