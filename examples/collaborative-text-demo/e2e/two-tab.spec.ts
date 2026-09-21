import { test, expect } from "@playwright/test";

/**
 * Two-tab happy path: open the demo in two browser contexts under
 * different actor identities, type in tab 1, and confirm the text
 * appears in tab 2 within a few seconds.
 *
 * This is the foundational slice of the slice-4 e2e suite (#61) — it
 * exercises the full bootstrap → SSE → materializer → CodeMirror
 * bridge → DOM render path. Other test files (presence, conflicts,
 * connection-state, bootstrap-catchUp, actor-picker) build on the same
 * scaffolding and will be added in follow-up PRs.
 *
 * ## Regression coverage (#86)
 *
 * This test is the canary for a server-side SSE bug that previously
 * hung the second of two simultaneous subscribers. The `SSEConnection`
 * GenServer used to register itself with the global name `__MODULE__`,
 * so the first `/sync/live` succeeded but every subsequent one
 * crashed with `:already_started` before it ever wrote a chunk. The
 * client saw HTTP 200 + headers, then no events — drew's typed text
 * never reached alice. PR #50 removed the global-name registration;
 * PR #87 fixed the CI release cache so the fix actually shipped.
 *
 * The two assertions that catch this exact failure mode:
 *
 * 1. `await expect(alicePage.getByText("live")).toBeVisible()` —
 *    alice's "live" badge requires her SSE to actually connect.
 *    A `:already_started` crash leaves the state machine in
 *    `reconnecting`, not `live`, so this assertion times out.
 * 2. The final `toContainText(sentinel)` — even if the badge
 *    somehow reaches "live" through a stale state, the SSE-delivered
 *    action is what populates alice's editor.
 *
 * If a future change re-introduces the global-name registration (or
 * any other regression that prevents a second subscriber from
 * receiving events), this test fails fast.
 *
 * ## Fresh data dir per run
 *
 * The demo's bootstrap seeds a default group + member + doc on first
 * request. The `webServer` entry in `playwright.config.ts` does
 * `rm -rf` on the data dir before starting, so each CI run starts
 * from a known state. Reusing a previous run's state would mask
 * actor-isolation regressions (e.g., a leaked group membership from
 * a prior run masking a missing addMember call).
 */
test.describe("two-tab collaborative editing", () => {
  test("text typed in tab 1 appears in tab 2 within a few seconds", async ({ browser }) => {
    const drew = await browser.newContext();
    const alice = await browser.newContext();

    const drewPage = await drew.newPage();
    const alicePage = await alice.newPage();

    // Surface browser console to test logs (CI only) so we can see
    // Load the demo under two distinct actor identities via the
    // `?actor=` deep-link seed (the ActorPicker PR keeps the URL
    // parameter as a fallback).
    await drewPage.goto("/?actor=drew");
    await alicePage.goto("/?actor=alice");

    // Wait for both tabs to finish bootstrapping. The bootstrap status
    // is reflected in the URL hash or the header; the safest signal
    // here is the connection badge, which transitions to "live" once
    // SSE opens. We wait specifically for "live" rather than the
    // broader /live|connecting|reconnecting/ regex to avoid racing the
    // bootstrap (where the badge briefly reads "connecting" before
    // SSE actually connects).
    await expect(drewPage.getByText("live").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(alicePage.getByText("live").first()).toBeVisible({
      timeout: 30_000,
    });

    // Type a unique sentinel into drew's editor.
    const sentinel = `two-tab-${Date.now()}`;
    const drewEditor = drewPage.locator(".cm-content").first();
    await drewEditor.click();
    await drewEditor.press("End");
    await drewEditor.pressSequentially(sentinel);

    // The text should propagate to alice's tab via SSE within a few
    // seconds. The 30s expect timeout is generous to absorb cold-start
    // jitter on CI runners (full bootstrap + SSE round-trip + CM6
    // bridge + DOM render can easily take 10-15s on first run).
    await expect(alicePage.locator(".cm-content").first()).toContainText(sentinel, {
      timeout: 30_000,
    });

    await drew.close();
    await alice.close();
  });
});
