import { describe, it, expect } from "vitest";
import { ConnectionStateMachine } from "./connection-state";

describe("ConnectionStateMachine", () => {
  it("starts in 'connecting' state", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.state).toBe("connecting");
  });

  it("transitions and notifies listeners", () => {
    const sm = new ConnectionStateMachine();
    const events: Array<[string, string]> = [];
    sm.onChange((next, prev) => events.push([next, prev]));
    sm.transition("live");
    sm.transition("reconnecting");
    sm.transition("live");
    expect(events).toEqual([
      ["live", "connecting"],
      ["reconnecting", "live"],
      ["live", "reconnecting"],
    ]);
  });

  it("does not notify when transitioning to the same state", () => {
    const sm = new ConnectionStateMachine();
    const events: string[] = [];
    sm.onChange((next) => events.push(next));
    sm.transition("connecting"); // already in connecting
    expect(events).toEqual([]);
  });

  it("returns an unsubscribe function", async () => {
    const sm = new ConnectionStateMachine();
    const events: string[] = [];
    const unsub = sm.onChange((next) => events.push(next));
    await new Promise((r) => setTimeout(r, 10)); // let initial fire
    unsub();
    sm.transition("live");
    expect(events).toEqual(["connecting"]);
  });

  it("swallows listener errors", async () => {
    const sm = new ConnectionStateMachine();
    const events: string[] = [];
    sm.onChange(() => {
      throw new Error("boom");
    });
    sm.onChange((next) => events.push(next));
    sm.transition("live");
    expect(events).toEqual(["live"]);
    expect(sm.state).toBe("live");
  });

  it("fires listener once on subscribe with current state", async () => {
    const sm = new ConnectionStateMachine();
    sm.transition("live");
    const events: Array<[string, string]> = [];
    sm.onChange((next, prev) => events.push([next, prev]));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([["live", "live"]]);
  });

  it("supports multiple subscribers", () => {
    const sm = new ConnectionStateMachine();
    const a: string[] = [];
    const b: string[] = [];
    sm.onChange((s) => a.push(s));
    sm.onChange((s) => b.push(s));
    sm.transition("live");
    expect(a).toEqual(["live"]);
    expect(b).toEqual(["live"]);
  });
});
