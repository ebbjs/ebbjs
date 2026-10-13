import type { Route } from "@playwright/test";

import { test, expect, applyTestConfig, isolateTestGroup } from "./helpers";

/**
 * Conflict surfacing — a concurrent same-run edit made while the losing
 * tab is cut off from the live stream surfaces through `client.conflicts`
 * once that tab reconnects.
 *
 * ## Background
 *
 * Live sync is pure convergence (#390): an inbound Action that out-dates
 * a buffered local write is merged and materialized, and no conflict row
 * is written. Detection is catch-up only — it runs once per reconnect,
 * after the whole missed window is drained and before the flush gate
 * reopens. A same-position race therefore surfaces only when the losing
 * tab did not receive the winning write before its catch-up.
 *
 * A collaborative-text document stores its runs as keys of one map field
 * (`content`), so the wire's per-key merge decides what overlaps:
 *
 *   1. Two Updates write the SAME run key (`content.map[<runId>]`).
 *   2. The buffered write's `basedOnGsn` trails the missed Action's GSN,
 *      so the two are concurrent as far as this client can tell.
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
 * ## How this spec exercises the scenario
 *
 * Use the `__EBB_DEMO_TEST_CONFIG__.exposeState` seam (set via
 * `applyTestConfig` before navigation) to expose `forceExtend`/`reconnect`
 * on `window.__EBB_DEMO_TEST_STATE__`. Then:
 *
 *   1. Open both tabs and type "Hello" in drew's editor (creates run_A).
 *   2. Cut alice's tab off from `/sync/live` and `/sync/actions` with
 *      `page.route(...).abort()`, then force a reconnect. Her established
 *      stream is closed and her re-subscribe is aborted, so from here on
 *      she receives no live data and her writes stay buffered. (A plain
 *      `context.setOffline` is not enough — an already-open SSE stream
 *      keeps delivering.)
 *   3. Alice extends run_A and flushes. The POST aborts, so her write is
 *      durably buffered on a `basedOnGsn` that predates drew's.
 *   4. Drew extends the same run (still live) and commits it.
 *   5. Lift the aborts and force alice to reconnect. Catch-up pulls
 *      drew's committed Action and the detection pass moves alice's
 *      buffered write to `client.conflicts`.
 *   6. Assert the panel shows an entry on alice and none on drew, who was
 *      live throughout and converged silently.
 *
 * The pinned HLC keeps the two extends at the same logical time so the
 * merge is a genuine same-key race; the GSN base is what decides
 * concurrency.
 */
test.describe("conflict surfacing", () => {
  test("a concurrent extend surfaces through client.conflicts on reconnect", async ({
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
    const runIdOn = async (page: typeof drewPage): Promise<string | undefined> =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { getRunIds: () => readonly string[] };
          }
        ).__EBB_DEMO_TEST_STATE__;
        return state?.getRunIds()[0];
      });
    await expect.poll(() => runIdOn(drewPage), { timeout: 15_000 }).not.toBeUndefined();
    await expect.poll(() => runIdOn(alicePage), { timeout: 15_000 }).not.toBeUndefined();

    const runId = await runIdOn(drewPage);
    if (!runId) throw new Error("expected a run id after typing Hello");

    // Compute a pinned HLC that's the SAME on both tabs so the two
    // forced extends have truly concurrent HLCs. The HLC is
    // `(logicalTime << 16) | counter`; we pick a logical time in the
    // near future so neither tab's local clock (which advances on
    // Date.now()) can overtake it before both dispatch.
    const pinnedHlc = (BigInt(Date.now() + 60_000) << 16n) | 1n;
    const pinnedHlcStr = pinnedHlc.toString();

    const forceExtend = (page: typeof drewPage, text: string): Promise<unknown> =>
      page.evaluate(
        ({ runId, text, hlc }) => {
          const state = (
            window as unknown as {
              __EBB_DEMO_TEST_STATE__?: {
                forceExtend: (runId: string, appendText: string, hlc: string) => string | null;
              };
            }
          ).__EBB_DEMO_TEST_STATE__;
          if (!state) throw new Error("missing test state");
          return state.forceExtend(runId, text, hlc);
        },
        { runId, text, hlc: pinnedHlcStr },
      );
    const flush = (page: typeof drewPage): Promise<unknown> =>
      page.evaluate(async () => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { flushPending: () => Promise<unknown> };
          }
        ).__EBB_DEMO_TEST_STATE__;
        try {
          await state?.flushPending();
        } catch {
          // Aborted mid-flight: the outbox holds the write for reconnect.
        }
      });
    const reconnect = (page: typeof drewPage): Promise<unknown> =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { reconnect: () => void };
          }
        ).__EBB_DEMO_TEST_STATE__;
        state?.reconnect();
      });

    // Cut alice off the live stream and the write path, keeping the
    // catch-up endpoint reachable. Force a reconnect so her established
    // stream is torn down and replaced by one that aborts.
    const abortLive = (route: Route): Promise<void> => route.abort();
    const abortActions = (route: Route): Promise<void> => route.abort();
    await alicePage.route(/\/sync\/live/, abortLive);
    await alicePage.route(/\/sync\/actions/, abortActions);
    await reconnect(alicePage);

    // Alice extends the shared run; the aborted POST leaves the write
    // durably buffered on its pre-missed-window base.
    await forceExtend(alicePage, "A");
    await flush(alicePage);

    // Drew extends the same run (still live) and commits it. `write`
    // resolves only after the server accepted the Action.
    await forceExtend(drewPage, "D");
    await flush(drewPage);

    // Open the conflict panel on both tabs before reconnecting. The panel
    // follows `client.conflicts.onChange`, so it reflects a detection that
    // lands during the reconnect. The button toggles visibility; the panel
    // itself lives in an `<aside>`.
    await drewPage.getByRole("button", { name: /Show conflicts/i }).click();
    await alicePage.getByRole("button", { name: /Show conflicts/i }).click();

    // Lift the aborts and reconnect: catch-up pulls drew's committed
    // Action and the detection pass moves alice's buffered write to
    // `client.conflicts` before the flush gate reopens.
    await alicePage.unroute(/\/sync\/live/, abortLive);
    await alicePage.unroute(/\/sync\/actions/, abortActions);
    await reconnect(alicePage);

    await expect
      .poll(async () => alicePage.locator("aside li").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    // Drew, live throughout, merged and converged with nothing to surface.
    expect(await drewPage.locator("aside li").count()).toBe(0);

    await firstCtx.close();
    await secondCtx.close();
  });
});
