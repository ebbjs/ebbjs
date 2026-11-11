/**
 * Tests for `useSyncObservable` — the generic `useSyncExternalStore` wrapper
 * the client-backed hooks build on, exported for third-party observables.
 *
 * The fake below is hand-rolled on purpose: the hook takes any
 * `ReadonlyObservable<T>`, not just the client's own implementation, so an
 * app-owned observable must work without one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { ReadonlyObservable } from "@ebbjs/client";
import { useSyncObservable } from "../index";

afterEach(cleanup);

interface FakeObservable<T> extends ReadonlyObservable<T> {
  set(value: T): void;
  subscriptions(): number;
}

function fakeObservable<T>(initial: T): FakeObservable<T> {
  let current = initial;
  let subscriptions = 0;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    subscribe(listener) {
      subscriptions += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value) {
      current = value;
      for (const listener of listeners) listener(value);
    },
    subscriptions: () => subscriptions,
  };
}

function ValueProbe({ observable }: { observable: ReadonlyObservable<number> }) {
  const value = useSyncObservable(observable);
  return <span data-testid="value">{value}</span>;
}

function ValueProbeWithRerender({ observable }: { observable: ReadonlyObservable<number> }) {
  const [, setTick] = useState(0);
  const value = useSyncObservable(observable);
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button data-testid="rerender" onClick={() => setTick((tick) => tick + 1)} />
    </div>
  );
}

describe("useSyncObservable", () => {
  it("renders the observable's current value and re-renders when it changes", () => {
    const observable = fakeObservable(3);
    render(<ValueProbe observable={observable} />);

    expect(screen.getByTestId("value").textContent).toBe("3");

    act(() => observable.set(7));

    expect(screen.getByTestId("value").textContent).toBe("7");
  });

  it("keeps one subscription across re-renders of the same observable", () => {
    const observable = fakeObservable(1);
    render(<ValueProbeWithRerender observable={observable} />);

    act(() => screen.getByTestId("rerender").click());
    act(() => screen.getByTestId("rerender").click());

    expect(observable.subscriptions()).toBe(1);
  });
});
