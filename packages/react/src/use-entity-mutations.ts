import { useCallback, useMemo } from "react";
import type { EntityNamespace, TSchema } from "@ebbjs/client";

/**
 * Write pass-throughs for one entity namespace. The three functions
 * forward to `EntityNamespace.create` / `update` / `delete` unchanged;
 * the hook adds no caching or optimistic layer of its own.
 */
export interface UseEntityMutationsResult<TFields extends Record<string, TSchema>> {
  readonly create: EntityNamespace<TFields>["create"];
  readonly update: EntityNamespace<TFields>["update"];
  readonly delete: EntityNamespace<TFields>["delete"];
}

/**
 * Bind a component to the write side of `client.<entity>`.
 *
 * The returned functions are referentially stable while `namespace` is
 * stable — `client.<entity>` is a long-lived object, so a component can
 * list the mutators as effect / callback dependencies without churn.
 */
export function useEntityMutations<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = Record<never, never>,
>(namespace: EntityNamespace<TFields, TAccessors>): UseEntityMutationsResult<TFields> {
  const create = useCallback(
    (...args: Parameters<EntityNamespace<TFields>["create"]>) => namespace.create(...args),
    [namespace],
  );
  const update = useCallback(
    (...args: Parameters<EntityNamespace<TFields>["update"]>) => namespace.update(...args),
    [namespace],
  );
  const remove = useCallback(
    (...args: Parameters<EntityNamespace<TFields>["delete"]>) => namespace.delete(...args),
    [namespace],
  );

  return useMemo(() => ({ create, update, delete: remove }), [create, update, remove]);
}
