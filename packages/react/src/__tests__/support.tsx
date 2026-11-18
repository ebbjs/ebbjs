/**
 * The react suites' shared harness: one client builder and one provider
 * wrapper, so a suite exercises the hooks rather than its own copy of the
 * connection config.
 *
 * `makeClient` fixes the server URL and actor every suite shares and passes
 * whatever the caller narrows with — `{ schema }`, `{ schema, presence }` —
 * straight through, so `createClient` infers the suites' own types: a hook's
 * `q`, its rows, and `client.presence` stay typed from the declaring schema
 * instead of widening to "some schema".
 */

import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createClient,
  type AnyPresenceRegistry,
  type SyncClient,
  type SyncClientOptions,
} from "@ebbjs/client";

import { EbbProvider } from "../index";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "test-actor";

/** A `defineSchema(...)` result, as `createClient` accepts it. */
type SchemaLike = NonNullable<SyncClientOptions["schema"]>;
/** A `definePresence(...)` registry, as `createClient` accepts it. */
type PresenceLike = NonNullable<SyncClientOptions<AnyPresenceRegistry>["presence"]>;

export const makeClient = <
  S extends SchemaLike | undefined = undefined,
  R extends PresenceLike | undefined = undefined,
>(
  overrides: Omit<SyncClientOptions<R>, "serverUrl" | "actorId" | "schema" | "presence"> & {
    schema?: S;
    presence?: R;
  } = {},
) => createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, ...overrides });

/** `ui` inside `<EbbProvider>`, for a `rerender` that has to re-wrap the tree. */
export const withProvider = (client: SyncClient, ui: ReactNode) => (
  <EbbProvider client={client}>{ui}</EbbProvider>
);

/** Render `ui` inside a provider for `client`. */
export const renderWithClient = (client: SyncClient, ui: ReactNode): RenderResult =>
  render(withProvider(client, ui));
