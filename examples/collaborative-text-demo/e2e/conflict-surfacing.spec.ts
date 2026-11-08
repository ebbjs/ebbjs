import type { Route } from "@playwright/test";

import { test, expect, applyTestConfig, isolateTestGroup } from "./helpers";

/**
 * Same-run concurrency after the #764 rebuild.
 *
 * This spec used to assert the devlog "Colour" conflict: two tabs extending
 * the same run while one was offline surfaced a slot on reconnect. After the
 * rebuild a run is immutable and an extend is a new run anchored at the old
 * one's end, so the two writes are different `content` keys. There is no
 * contested position, no conflict row, and both tabs converge on the same
 * text.
 *
 * The reconnect machinery (cut the live stream + write path, force a
 * reconnect, then lift the aborts) is kept because it is the path that used
 * to produce the loss: it still must converge without surfacing anything.
 */
test.describe("same-run concurrency", () => {
  test("two disconnected extends converge and surface no conflict on reconnect", async ({
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

    await expect(drewPage.getByText("live").first()).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByText("live").first()).toBeVisible({ timeout: 30_000 });

    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially("Hello");

    await expect(drewEditor).toContainText("Hello", { timeout: 5_000 });
    await expect(alicePage.locator(".cm-content").first()).toContainText("Hello", {
      timeout: 30_000,
    });

    const runIdOn = async (page: typeof drewPage): Promise<string | undefined> =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { getRunIds: () => readonly string[] };
          }
        ).__EBB_DEMO_TEST_STATE__;
        return state?.getRunIds().at(-1);
      });
    await expect.poll(() => runIdOn(drewPage), { timeout: 15_000 }).not.toBeUndefined();
    await expect.poll(() => runIdOn(alicePage), { timeout: 15_000 }).not.toBeUndefined();

    const runId = await runIdOn(drewPage);
    if (!runId) throw new Error("expected a run id after typing Hello");

    // Pin both extends to the same logical time so the only tiebreak is the
    // actor id — the deterministic part of the total order.
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

    const abortLive = (route: Route): Promise<void> => route.abort();
    const abortActions = (route: Route): Promise<void> => route.abort();
    await alicePage.route(/\/sync\/live/, abortLive);
    await alicePage.route(/\/sync\/actions/, abortActions);
    await reconnect(alicePage);

    await forceExtend(alicePage, "A");
    await flush(alicePage);

    await forceExtend(drewPage, "D");
    await flush(drewPage);

    await drewPage.getByRole("button", { name: /Show conflicts/i }).click();
    await alicePage.getByRole("button", { name: /Show conflicts/i }).click();

    await alicePage.unroute(/\/sync\/live/, abortLive);
    await alicePage.unroute(/\/sync\/actions/, abortActions);
    await reconnect(alicePage);
    // The buffered write was never a conflict; releasing the write path lets
    // it reach the server so both tabs can converge.
    await flush(alicePage);

    // Both characters survive and both tabs project the same text; the
    // exact order is the total order's, not arrival order. Read the
    // document's projected text, not `innerText`: CM renders presence
    // widgets inside the content element.
    const textOn = (page: typeof drewPage): Promise<string> =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __EBB_DEMO_TEST_STATE__?: { getText: () => string };
          }
        ).__EBB_DEMO_TEST_STATE__;
        return state?.getText() ?? "";
      });
    await expect.poll(() => textOn(alicePage), { timeout: 30_000 }).toMatch(/^Hello[AD]{2}$/);
    await expect.poll(() => textOn(drewPage), { timeout: 30_000 }).toMatch(/^Hello[AD]{2}$/);
    expect(await textOn(alicePage)).toBe(await textOn(drewPage));

    // No slot: the two writes are different cell keys.
    await expect.poll(async () => alicePage.locator("aside li").count()).toBe(0);
    expect(await drewPage.locator("aside li").count()).toBe(0);

    await firstCtx.close();
    await secondCtx.close();
  });
});
