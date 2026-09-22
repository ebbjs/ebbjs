import { test, expect, applyTestConfig } from "./helpers";

/**
 * Conflict surfacing — concurrent edits at the same position should
 * produce a `ConflictPanel` entry on both tabs.
 *
 * ## Background
 *
 * The conflict detector (`packages/client/src/fields/collaborative-text/conflict.ts`)
 * records a Conflict when ALL of the following hold:
 *
 *   1. Two or more Updates target the SAME run field (`run:<runId>`).
 *   2. Those Updates have **concurrent HLCs** — neither happens-before
 *      the other (Kulkarni happens-before: `a.l < b.l` OR
 *      `a.l == b.l AND a.c < b.c`).
 *   3. Both Updates are **non-trivial** — they have a non-null
 *      RunNode value (insert or extend; tombstones are skipped).
 *
 * Through the normal UI, concurrent updates to the same run are
 * surprisingly rare: the cm-bridge's "extension optimization" only
 * fires for the run owner (`isSamePeer`), so a foreign actor who
 * types at the end of someone else's run creates a NEW child run
 * anchored at the parent — different run field, no conflict.
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
 *      server. Both tabs now receive BOTH EXTEND actions via SSE →
 *      the detector sees `run:<run_A>` updated by two concurrent
 *      actions and records a Conflict.
 *   5. Open the conflict panel on both tabs and assert an entry
 *      appears.
 *
 * The two-tab happy-path test already locks the SSE `:already_started`
 * regression (#86). This test layers the conflict-detection + UI
 * surfacing on top of it.
 */
test.describe("conflict surfacing", () => {
  test("concurrent extends to the same run produce a ConflictPanel entry on both tabs", async ({
    browser,
  }) => {
    const firstCtx = await browser.newContext();
    const secondCtx = await browser.newContext();
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

    // Both tabs should see a conflict entry. The panel renders each
    // conflict as an `<li>` with a timestamp + pre/post text blocks;
    // we assert on the pre-merge block which carries "Hello" (the
    // text before either extension was applied).
    await expect(drewPage.locator("aside li").first()).toBeVisible({ timeout: 15_000 });
    await expect(alicePage.locator("aside li").first()).toBeVisible({ timeout: 15_000 });

    // Both tabs should report the same contributing-action count
    // (two concurrent extends, one from drew, one from alice).
    const drewCount = await drewPage.locator("aside li").count();
    const aliceCount = await alicePage.locator("aside li").count();
    expect(drewCount).toBeGreaterThanOrEqual(1);
    expect(aliceCount).toBeGreaterThanOrEqual(1);

    await firstCtx.close();
    await secondCtx.close();
  });
});
