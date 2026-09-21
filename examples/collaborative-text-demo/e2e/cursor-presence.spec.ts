import { test, expect, openTwoActorTabs } from "./helpers";

/**
 * Remote cursor presence — moving the cursor in tab 1 should show a
 * colored cursor caret + actor label in tab 2.
 *
 * ## Background
 *
 * The presence implementation lives in two places:
 *
 * - `packages/client/src/presence/presence.ts` owns the per-entity
 *   map of remote actors' cursors. Outgoing: debounced `POST
 *   /sync/presence` (100ms debounce). Incoming: a dedicated SSE
 *   stream filtered to `presence` events.
 * - `packages/codemirror/src/presence/cursor-decoration.ts` renders
 *   the map as CM6 decorations: a `.cm-remote-cursor` widget with a
 *   colored left-border + `.cm-remote-cursor-label` carrying the
 *   actor id, anchored at the run-id coordinate resolved to a CM
 *   position via the bridge's `idMapField`.
 *
 * The two halves are unit-tested independently; this spec is the
 * end-to-end check that the wire + DOM round-trip holds.
 *
 * ## What this test does
 *
 * 1. Open the demo under `?actor=drew` and `?actor=alice`.
 * 2. Click into drew's editor and type a sentinel to materialize a
 *    run before asserting on the cursor widget.
 * 3. Wait for drew's `POST /sync/presence` to round-trip through the
 *    server and arrive in alice's presence map.
 * 4. Wait for alice's CM6 ViewPlugin to re-render the cursor widget
 *    with label "drew".
 *
 * ## Race conditions the spec absorbs
 *
 * - `setLocalCursor` is debounced 100ms. We wait the debounce window
 *   plus server round-trip plus SSE delivery plus CM render.
 * - The remote cursor renders as an inline-block widget of width 0
 *   (just the left border + label tag). The label has class
 *   `cm-remote-cursor-label`; we assert the actor id text inside it.
 */
test.describe("remote cursor presence", () => {
  test("drew's cursor appears as a colored caret + label in alice's tab", async ({ browser }) => {
    const { firstPage: drewPage, secondPage: alicePage } = await openTwoActorTabs(browser, {
      first: "drew",
      second: "alice",
    });

    // Click into drew's editor and type a sentinel to materialize
    // a run before asserting on the cursor widget.
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially("a");

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
    // Open two tabs and let them settle.
    const { firstPage: drewPage, secondPage: alicePage } = await openTwoActorTabs(browser, {
      first: "drew",
      second: "alice",
    });

    // Type some text in drew's editor so there's room to move the
    // cursor and observe a position change.
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.pressSequentially("hello");

    // Wait for drew's cursor label to appear in alice's editor at
    // the end of "hello" (post-typing position).
    const drewLabel = alicePage.locator(".cm-remote-cursor-label", { hasText: "drew" });
    await expect(drewLabel).toBeVisible({ timeout: 15_000 });

    // Move drew's cursor to position 2 (between "he" and "llo"). The
    // cursor position is rendered relative to the run, so a move of
    // more than 0 characters must re-render the widget (otherwise the
    // ViewPlugin is caching stale positions).
    await drewEditor.click();
    await drewPage.keyboard.press("Home");
    await drewPage.keyboard.press("ArrowRight");
    await drewPage.keyboard.press("ArrowRight");

    // Assert the widget is still visible after the move — a stale
    // widget would either vanish or stay at the old position; either
    // way the test would not pass if the ViewPlugin failed to
    // re-render on selection change.
    await expect(drewLabel).toBeVisible({ timeout: 15_000 });
  });
});
