import { useCallback, useSyncExternalStore } from "react";
import type { ReadonlyObservable } from "@ebbjs/client";

/**
 * Subscribe a component to any {@link ReadonlyObservable} — a synchronous
 * `get()` plus a `subscribe(cb)` returning an unsubscribe function.
 *
 * The client's sync state (`client.sync.outbox`, `client.sync.conflicts`,
 * `client.sync.backfill`, `client.status`) is already published in that
 * shape, so this hook is all a framework binding needs. It is exported for
 * observables the app owns too: a canvas or an editor can publish one and
 * render it with the same hook.
 *
 * `subscribe` and `getSnapshot` are stable per observable, so a re-render
 * does not resubscribe and a stable snapshot does not loop. The observable
 * must return the same reference until its value changes.
 */
export function useSyncObservable<T>(observable: ReadonlyObservable<T>): T {
  const subscribe = useCallback(
    (onStoreChange: () => void) => observable.subscribe(onStoreChange),
    [observable],
  );
  const getSnapshot = useCallback(() => observable.get(), [observable]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
