import { test, expect, applyTestConfig, isolateTestGroup } from "./helpers";

/**
 * Conflict surfacing — concurrent edits at the same position should
 * produce a `ConflictPanel` entry on the losing tab.
 *
 * ## Background
 *
 * Conflict detection lives in the outbox (`client.conflicts`). A
 * collaborative-text document stores its runs as keys of one map field
 * (`content`), so the wire's per-key merge decides what conflicts:
 *
 *   1. Two Updates write the SAME run key (`content.map[<runId>]`).
 *   2. Neither happens-before the other by HLC, and the incoming leaf
 *      out-dates the pending one (LWW), so the pending write loses.
 *
 * Concurrent inserts at different positions write different keys and
 * never conflict; a concurrent extend-vs-delete on one run is one slot
 * and does.
 *
 * Through the normal UI, concurrent updates to the same run are
 * surprisingly rare: the cm-bridge's "extension optimization" only
 * fires for the run owner (`isSamePeer`), so a foreign actor who
 * types at the end of someone else's run creates a NEW child run
 * anchored at the parent — different run key, no conflict.
 *
 * To trigger a conflict reliably through the UI we'd need to force
 * two actors to both extend the same run with concurrent HLCs, which
 * depends on HLC drift timing that's hard to reproduce in CI.
 *
 * ## How this spec exercises the scenario
 *
 * Use the `__EBB_DEMO_TEST_CONFIG__.exposeState` seam (set via
 * `applyTestConfig` before navigation) to expose `forceExtend` on
 * `window.__EBB_DEMO_TEST_STATE__`. Then:
 *
 *   1. Open both tabs and type "Hello" in tab 1 (creates run_A).
 *   2. Wait for both tabs to have run_A in their state.
 *   3. Compute a pinned HLC (same value on both tabs) and call
 *      `forceExtend(run_A, "X", hlc)` on BOTH tabs concurrently.
 *      The pinned HLC skips the per-tab auto-advance, so the two
 *      extensions land with truly concurrent HLCs.
 *   4. Wait for both tabs to flush their pending actions to the
 *      server. Each tab receives the other's EXTEND via SSE; the outbox
 *      compares the same run key and moves the losing buffered write
 *      to `client.conflicts`. The winner's own echo retires its entry
 *      first, so only the loser records the conflict.
 *   5. Open the conflict panel on both tabs and assert an entry
 *      appears on the loser (`client.conflicts`).
 *
 * The two-tab happy-path test already locks the SSE `:already_started`
 * regression (#86). This test layers the conflict-detection + UI
 * surfacing on top of it.
 */
test.describe("conflict surfacing", () => {
  test("concurrent extends to the same run surface through client.conflicts", async ({
    browser,
  }) => {
    const firstCtx = await browser.newContext();
    const secondCtx = await browser.newContext();
    const groupId = await isolateTestGroup(firstCtx);
    await isolateTestGroup(secondCtx, groupId);
    await applyTestConfig(firstCtx, { exposeState: true });
    await applyTestConfig(secondCtx, { exposeState: true });

    const drewPage = await firstCtx.newPage();
    const alicePage = await secondCtx.newPage();

    await drewPage.goto("/?actor=drew");
    await alicePage.goto("/?actor=alice");

    // Wait for both tabs to reach "live" before exercising anything.
    // Same rationale as the foundational two-tab test.
    await expect(drewPage.getByText("live").first()).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByText("live").first()).toBeVisible({ timeout: 30_000 });

    // Type "Hello" in drew's editor to create a run we can later extend.
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially("Hello");

    // Wait for drew's editor to contain "Hello" (typing is local-immediate
    // via the bridge's optimistic apply).
    await expect(drewPage.locator(".cm-content").first()).toContainText("Hello", {
      timeout: 5_000,
    });

    // Wait for alice's editor to receive drew's "Hello" via catchUp
    // (or SSE) so both tabs have the same run in their state.
    await expect(alicePage.locator(".cm-content").first()).toContainText("Hello", {
      timeout: 30_000,
    });

    // Wait for the test handle on both tabs to expose the run id.
    await expect
      .poll(
        async () => {
          const ids = await drewPage.evaluate(() => {
            const state = (
              window as unknown as {
                __EBB_DEMO_TEST_STATE__?: { getRunIds: () => readonly string[] };
              }
            ).__EBB_DEMO_TEST_STATE__;
            return state?.getRunIds() ?? [];
          });
          return ids.length > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const ids = await alicePage.evaluate(() => {
            const state = (
              window as unknown as {
                __EBB_DEMO_TEST_STATE__?: { getRunIds: () => readonly string[] };
              }
            ).__EBB_DEMO_TEST_STATE__;
            return state?.getRunIds() ?? [];
          });
          return ids.length > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const runId = await drewPage.evaluate(() => {
      const state = (
        window as unknown as {
          __EBB_DEMO_TEST_STATE__?: { getRunIds: () => readonly string[] };
        }
      ).__EBB_DEMO_TEST_STATE__;
      return state?.getRunIds()[0];
    });
    if (!runId) throw new Error("expected a run id after typing Hello");

    // Compute a pinned HLC that's the SAME on both tabs so the two
    // forced extends have truly concurrent HLCs. The HLC is
    // `(logicalTime << 16) | counter`; we pick a logical time in the
    // near future so neither tab's local clock (which advances on
    // Date.now()) can overtake it before both dispatch.
    const pinnedHlc = (BigInt(Date.now() + 60_000) << 16n) | 1n;
    const pinnedHlcStr = pinnedHlc.toString();

    // Dispatch the concurrent extends. Promise.all so both fire as
    // close to simultaneously as Playwright's RPC allows.
    await Promise.all([
      drewPage.evaluate(
        ({ runId, hlc }) => {
          const state = (
            window as unknown as {
              __EBB_DEMO_TEST_STATE__?: {
                forceExtend: (runId: string, appendText: string, hlc: string) => string | null;
              };
            }
          ).__EBB_DEMO_TEST_STATE__;
          if (!state) throw new Error("missing test state");
          return state.forceExtend(runId, "D", hlc);
        },
        { runId, hlc: pinnedHlcStr },
      ),
      alicePage.evaluate(
        ({ runId, hlc }) => {
          const state = (
            window as unknown as {
              __EBB_DEMO_TEST_STATE__?: {
                forceExtend: (runId: string, appendText: string, hlc: string) => string | null;
              };
            }
          ).__EBB_DEMO_TEST_STATE__;
          if (!state) throw new Error("missing test state");
          return state.forceExtend(runId, "A", hlc);
        },
        { runId, hlc: pinnedHlcStr },
      ),
    ]);

    // Flush both tabs so the actions reach the server.
    await Promise.all([
      drewPage.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { flushPending: () => Promise<unknown> };
          }
        ).__EBB_DEMO_TEST_STATE__;
        return state?.flushPending();
      }),
      alicePage.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { flushPending: () => Promise<unknown> };
          }
        ).__EBB_DEMO_TEST_STATE__;
        return state?.flushPending();
      }),
    ]);

    // Open the conflict panel on both tabs. The button toggles
    // visibility; the panel itself lives in an `<aside>`.
    await drewPage.getByRole("button", { name: /Show conflicts/i }).click();
    await alicePage.getByRole("button", { name: /Show conflicts/i }).click();

    // Exactly one side loses a same-run race: the winner's own echo
    // retires its outbox entry before the peer's write lands, while the
    // loser's buffered write is moved to `client.conflicts`. Which tab
    // loses depends on commit order, so assert the race surfaces on at
    // least one tab.
    await expect
      .poll(
        async () =>
          (await drewPage.locator("aside li").count()) +
          (await alicePage.locator("aside li").count()),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await firstCtx.close();
    await secondCtx.close();
  });
});
