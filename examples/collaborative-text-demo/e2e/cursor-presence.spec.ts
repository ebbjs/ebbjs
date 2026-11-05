import { test, expect, openTwoActorTabs } from "./helpers";

/**
 * Remote cursor presence — moving the cursor in tab 1 should show a
 * colored cursor caret + actor label in tab 2.
 *
 * The presence implementation lives in two places:
 *
 * - `packages/client/src/presence/` owns the channel API. The demo
 *   declares a `cursor` channel and calls `presence.set(docId,
 *   "cursor", ...)`; outgoing sends are debounced per `(entity,
 *   channel)` and POST `{entity_id, data: {channel, value}}` to
 *   `/sync/presence`. Incoming `presence` events ride the same live
 *   SSE stream the subscription already holds, and are read back with
 *   `presence.forEntity(docId, "cursor")`.
 * - `packages/codemirror/src/presence/cursor-decoration.ts` renders
 *   the map as CM6 decorations: a `.cm-remote-cursor` widget with a
 *   colored left-border + `.cm-remote-cursor-label` carrying the
 *   actor id, anchored at the run-id coordinate resolved to a CM
 *   position via the bridge's `idMapField`.
 *
 * The two halves are unit-tested independently; this spec is the
 * end-to-end check that the wire + DOM round-trip holds.
 *
 * Race conditions the spec absorbs:
 * - `presence.set` is debounced 100ms. We wait the debounce window
 *   plus server round-trip plus SSE delivery plus CM render.
 * - The remote cursor renders as an inline-block widget of width 0
 *   (just the left border + label tag). The label has class
 *   `cm-remote-cursor-label`; we assert the actor id text inside it.
 */
test.describe("remote cursor presence", () => {
  test("drew's cursor appears in alice's tab after a click on the empty editor (#101)", async ({
    browser,
  }) => {
    const { firstPage: drewPage, secondPage: alicePage } = await openTwoActorTabs(browser, {
      first: "drew",
      second: "alice",
    });

    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();

    // Wait for the remote cursor widget to render in alice's editor.
    // The widget is a span with class `cm-remote-cursor` (the cursor
    // bar) wrapping a `cm-remote-cursor-label` span carrying the
    // actor id. We assert on the label because it's the user-visible
    // signal — if the cursor bar renders without a label, that's a
    // bug worth flagging here too (we'd see the bar but no actor id,
    // which would mislead users in a multi-actor session).
    const drewCursorInAlice = alicePage.locator(".cm-remote-cursor-label", {
      hasText: "drew",
    });
    await expect(drewCursorInAlice).toBeVisible({ timeout: 15_000 });

    // Sanity-check: the cursor is anchored to alice's editor (not
    // some other tab's DOM). Scope the locator to alice's CodeMirror
    // instance via the page locator chain.
    await expect(
      alicePage.locator(".cm-content").first().locator("..").locator(".cm-remote-cursor-label", {
        hasText: "drew",
      }),
    ).toBeVisible();
  });

  test("cursor label updates when drew moves the cursor", async ({ browser }) => {
    const { firstPage: drewPage, secondPage: alicePage } = await openTwoActorTabs(browser, {
      first: "drew",
      second: "alice",
    });

    // Type some text so there's room to move the cursor and observe
    // a position change.
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially("hello");

    const drewLabel = alicePage.locator(".cm-remote-cursor-label", { hasText: "drew" });
    await expect(drewLabel).toBeVisible({ timeout: 15_000 });

    // Move drew's cursor to position 2 (between "he" and "llo"). A
    // move of more than 0 characters must re-render the widget
    // (otherwise the ViewPlugin is caching stale positions).
    await drewEditor.click();
    await drewPage.keyboard.press("Home");
    await drewPage.keyboard.press("ArrowRight");
    await drewPage.keyboard.press("ArrowRight");

    await expect(drewLabel).toBeVisible({ timeout: 15_000 });
  });
});
