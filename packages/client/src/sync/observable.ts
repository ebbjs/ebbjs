/**
 * Read-only observable — a synchronous current value plus change
 * notifications.
 *
 * The pattern the client's sync state exposes (#125): `get()` reads the
 * latest value without I/O so a framework binding can wire it to
 * `useSyncExternalStore`, and `subscribe(cb)` fires after every change
 * and returns an unsubscribe function. The value is read-only from a
 * consumer's perspective — only the module that owns the value holds the
 * {@link ObservableSource} writer half.
 */

/** A read-only value consumers can read synchronously and subscribe to. */
export interface ReadonlyObservable<T> {
  /** The current value. Synchronous; never awaits I/O. */
  get(): T;
  /**
   * Subscribe to changes. The callback fires with the new value after
   * each change — not on subscribe itself; {@link get} already returns
   * the current value. Returns an unsubscribe function. Listeners are
   * isolated: a throwing listener does not affect the others.
   */
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * The owner's half: the read-only surface plus `set`, used to publish
 * changes to subscribers.
 */
export interface ObservableSource<T> extends ReadonlyObservable<T> {
  /** Replace the current value and notify subscribers. */
  set(value: T): void;
}

/** Build an {@link ObservableSource} over an initial value. */
export function createObservable<T>(initial: T): ObservableSource<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value) {
      current = value;
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[Observable] listener threw:", err);
        }
      }
    },
  };
}
