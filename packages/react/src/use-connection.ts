import { useCallback, useSyncExternalStore } from "react";
import type { ConnectionState } from "@ebbjs/client";
import { useClient } from "./context";

/**
 * Subscribe a component to the client's {@link ConnectionState}.
 *
 * Backed by `useSyncExternalStore` over `client.onStateChange`, so the
 * component re-renders on transitions (`connecting → live`,
 * `live → reconnecting`, …) and not on every action the client
 * processes. The snapshot is the state string itself, which is
 * referentially stable, so no caching layer is needed.
 */
export function useConnection(): ConnectionState {
  const client = useClient();

  const subscribe = useCallback(
    (onStoreChange: () => void) => client.onStateChange(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.state, [client]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
