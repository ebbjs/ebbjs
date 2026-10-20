/**
 * Busy / error state for one component's writes.
 *
 * Every write in the demo has the same shape: clear the previous
 * failure, mark the control busy, run the write, surface the error and
 * clear the busy flag. `useWrite` keeps that in one place; callers only
 * supply the write itself and decide what success means.
 */

import { useCallback, useState } from "react";

export interface WriteState {
  /** A write is in flight; disable the control that started it. */
  readonly pending: boolean;
  /** The last write's failure, cleared when the next write starts. */
  readonly error: string | null;
  /** Run `work`, recording any failure. */
  run(work: () => Promise<unknown>): Promise<void>;
}

export function useWrite(): WriteState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (work: () => Promise<unknown>): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, run };
}
