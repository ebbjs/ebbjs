/**
 * Connection state machine for the sync client.
 *
 * ## States
 * - `connecting` — handshake in progress, no live subscription yet
 * - `live` — at least one SSE subscription is open and receiving
 * - `reconnecting` — subscription dropped; backoff timer running
 * - `offline` — unrecoverable error (e.g., handshake rejected permanently)
 *
 * ## Transitions
 *
 *     connecting ─(handshake ok + subscribe ok)──▶ live
 *     connecting ─(handshake rejected)────────────▶ offline
 *     live ─(subscription error)──────────────────▶ reconnecting
 *     reconnecting ─(backoff fires)───────────────▶ connecting
 *     reconnecting ─(max retries exceeded)───────▶ offline
 *     offline ─(manual reset)─────────────────────▶ connecting
 *
 * The state is exposed as a simple pub/sub. Consumers subscribe via
 * `onChange(cb)`; the callback fires synchronously with the new state
 * and is also invoked once with the current state on subscription.
 */

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export type StateChangeListener = (state: ConnectionState, prev: ConnectionState) => void;

/**
 * ConnectionStateMachine — tracks the current connection state and notifies
 * subscribers when it changes. Pure logic, no I/O.
 */
export class ConnectionStateMachine {
  private _state: ConnectionState = "connecting";
  private readonly listeners = new Set<StateChangeListener>();

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Transition to a new state. No-op if equal.
   * Fires all listeners synchronously; listener errors are swallowed so a
   * misbehaving subscriber can't break the state machine.
   */
  transition(next: ConnectionState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    for (const cb of this.listeners) {
      try {
        cb(next, prev);
      } catch (err) {
        // Don't let a subscriber error kill the state machine.
        // eslint-disable-next-line no-console
        console.error("[ConnectionStateMachine] listener error:", err);
      }
    }
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   *
   * The callback fires immediately with the current state and then again on
   * every subsequent transition.
   */
  onChange(cb: StateChangeListener): () => void {
    this.listeners.add(cb);
    // Fire once with the current state so consumers don't need a separate
    // "current" lookup. Use queueMicrotask to defer until after the caller
    // finishes setup.
    queueMicrotask(() => {
      if (this.listeners.has(cb)) {
        try {
          cb(this._state, this._state);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[ConnectionStateMachine] listener error:", err);
        }
      }
    });
    return () => {
      this.listeners.delete(cb);
    };
  }
}
