import { test, expect, waitForLive } from "./helpers";

/**
 * Actor-picker UI — switching the actor identity via the in-app
 * dropdown should trigger a full re-bootstrap; the tab should reach
 * "live" again under the new identity, and a fresh peer tab under
 * the new identity should receive the original tab's edits.
 *
 * ## Background
 *
 * PR #77 replaced the `?actor=` URL parameter (kept as a deep-link
 * fallback) with an in-app dropdown (`ActorPicker.tsx`). Selecting an
 * actor calls `App.onActorChange`, which sets `actorId` state and
 * re-runs the `useEffect([actorId])` → `bootstrap({ actorId })` path.
 *
 * The old client is `client.close()`-d in the cleanup of the
 * previous render; the new bootstrap spins up a fresh SyncClient +
 * fresh SSE subscription. If the old client wasn't properly torn
 * down, you'd see duplicate subscriptions and the badge could
 * oscillate.
 *
 * ## What this spec verifies
 *
 *   1. Open tab A under `?actor=drew`, wait for "live".
 *   2. Switch the picker dropdown from "drew" to "alice".
 *   3. Wait for the tab to reach "live" again under the new actor.
 *   4. Open a fresh peer tab as `?actor=alice`.
 *   5. Type a sentinel in tab A; verify it propagates to the peer
 *      tab via SSE.
 *
 * Step 5 is the strongest signal: if the picker didn't actually
 * re-bootstrap (e.g., only updated UI state without calling
 * `bootstrap()`), the new client would still be drew's and alice's
 * tab wouldn't receive drew's writes.
 *
 * ## Selector choice
 *
 * The picker is a `<select>` with `KNOWN_ACTORS` ("drew", "alice",
 * "bob") + a "Custom…" option. We select "alice" by value; Playwright's
 * `selectOption` triggers the `change` event which is what the
 * component listens for.
 */
test.describe("actor picker UI", () => {
  test("switching actor via picker re-bootstraps; new peer receives edits", async ({ browser }) => {
    // Tab A: open as drew, then switch to alice via the picker.
    const tabACtx = await browser.newContext();
    const tabAPage = await tabACtx.newPage();
    await tabAPage.goto("/?actor=drew");
    await waitForLive(tabAPage);

    // Change the picker to "alice". The picker's <select> has the
    // actor ids as <option> values; Playwright's selectOption drives
    // the change event the component listens for.
    const picker = tabAPage.locator("select").first();
    await picker.selectOption("alice");

    // Wait for the tab to re-bootstrap and reach "live" again. The
    // intermediate "loading" / "connecting" state briefly shows in
    // the loading indicator OR the badge — both are acceptable
    // signals that the re-bootstrap is in progress.
    await waitForLive(tabAPage);

    // Sanity-check that the actor label in the header reflects the
    // new identity. The demo shows "actor: <id>" in the loading
    // state; in the ready state the picker value is the source of
    // truth, so we re-read the <select>'s selected option.
    await expect(picker).toHaveValue("alice");

    // Open a fresh peer tab as alice (separate context = separate
    // cookies / SSE state, simulating a second user opening the URL).
    const peerCtx = await browser.newContext();
    const peerPage = await peerCtx.newPage();
    await peerPage.goto("/?actor=alice");
    await waitForLive(peerPage);

    // Type a unique sentinel in tab A. Because tab A is now alice
    // (after the picker switch), this sentinel should appear in
    // alice's peer tab via SSE.
    const sentinel = `picker-${Date.now()}`;
    const tabAEditor = tabAPage.locator(".cm-content").first();
    await tabAEditor.click();
    await tabAEditor.press("End");
    await tabAEditor.pressSequentially(sentinel);

    await expect(peerPage.locator(".cm-content").first()).toContainText(sentinel, {
      timeout: 30_000,
    });

    await tabACtx.close();
    await peerCtx.close();
  });
});
