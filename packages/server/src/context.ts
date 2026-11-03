import type { EntityResponse } from "@ebbjs/client";

/**
 * The handler's view of one invocation.
 *
 * `S` is the application schema the function was defined against, carried so
 * handlers can be typed against the same schema as the rest of the app.
 */
export interface Context<S = unknown> {
  /** One entity, or `null` when it is absent or not visible to the subject. */
  get(id: string): Promise<EntityResponse | null>;
  /** The subject actor. Never client-supplied. */
  readonly actor: { readonly id: string };
  readonly caller: { readonly kind: "actor" | "service"; readonly id: string };
  readonly invocationId: string;
  /** Type-only marker for the application schema; never present at runtime. */
  readonly "~schema"?: S;
}
