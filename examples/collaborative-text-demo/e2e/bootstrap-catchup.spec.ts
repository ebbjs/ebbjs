import { test, expect, waitForLive } from "./helpers";

/**
 * Bootstrap catchUp — pre-populate a doc with N actions, open a fresh
 * tab, the doc should render with all prior actions.
 *
 * ## Background
 *
 * When `bootstrap()` completes, the Editor mounts a fresh TextDocument
 * and replays `caughtUpActions` into it BEFORE opening the SSE
 * subscription. Without that replay, a new tab would start empty even
 * if other tabs (or earlier sessions) had written to the doc — the
 * SSE stream only delivers future actions, not history.
 *
 * The catchUp path is `client.catchUp(groupId, cursor)` →
 * `GET /sync/groups/:group_id?offset=N`, paginated, terminated by
 * `stream-up-to-date: true` (or an empty page) once the client has
 * caught up. The bootstrap loops until `upToDate` so a doc with many
 * prior actions still converges to the current state on open.
 *
 * ## What this spec verifies
 *
 *   1. Type N characters in tab A (each character is a separate
 *      EXTEND_RUN action — see the bridge's "extension optimization"
 *      at the end of the same leaf run).
 *   2. Wait for the periodic flush (`FLUSH_INTERVAL_MS = 250`) to
 *      push all pending actions to the server.
 *   3. Open tab B as a fresh tab with the same actor. Bootstrap
 *      runs catchUp; the Editor renders the doc with all prior text.
 *   4. Assert tab B's editor shows the full prior text.
 *
 * The test asserts the END-TO-END catchUp behavior (text is rendered)
 * rather than poking at the catchUp network request directly — the
 * integration test on the same path (`packages/client/src/__tests__/integration/`)
 * already locks the protocol-level behavior; this spec is the DOM-level
 * canary.
 */
test.describe("bootstrap catchUp", () => {
  test("fresh tab renders all prior actions written by another tab", async ({ browser }) => {
    // Open tab A as drew, type a long string so we exercise multiple
    // actions (each character is an EXTEND under the same leaf run).
    const drewCtx = await browser.newContext();
    const drewPage = await drewCtx.newPage();
    await drewPage.goto("/?actor=drew");
    await waitForLive(drewPage);

    // Type a unique, recognizable string. 50 characters = at least
    // 50 EXTEND actions once the bridge's "extension optimization"
    // batches them under one run.
    const priorText = `catchup-${Date.now()}-${"x".repeat(40)}`;
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially(priorText);

    // Verify drew's own editor shows the text (optimistic local
    // apply). Then wait for the periodic flush to push all actions
    // to the server — the flush interval is 250ms; we give it 3s
    // headroom to be safe on cold-start CI runners.
    await expect(drewPage.locator(".cm-content").first()).toContainText(priorText, {
      timeout: 5_000,
    });
    // Wait at least 3 flush cycles (750ms) plus the write round-trip.
    await drewPage.waitForTimeout(3_000);

    // Open tab B as a different actor. Bob needs to be added to the
    // group first — but bootstrap calls addMember() idempotently on
    // every load, so this works without explicit setup.
    const bobCtx = await browser.newContext();
    const bobPage = await bobCtx.newPage();
    await bobPage.goto("/?actor=bob");
    await waitForLive(bobPage);

    // Tab B's editor should render with all the prior text from
    // tab A's writes. The bootstrap replays caughtUpActions before
    // opening the SSE subscription, so this text is in the doc even
    // if the SSE stream hasn't yet delivered anything.
    //
    // Generous timeout (30s) because the cold-start on a fresh CI
    // runner can take 10-15s for the full bootstrap → catchUp →
    // render pipeline.
    await expect(bobPage.locator(".cm-content").first()).toContainText(priorText, {
      timeout: 30_000,
    });

    await drewCtx.close();
    await bobCtx.close();
  });
});
