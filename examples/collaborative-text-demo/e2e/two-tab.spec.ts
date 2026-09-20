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
 * Why a fresh `data dir` per run: the demo's bootstrap seeds a default
 * group + member + doc on first request. Reusing a previous run's
 * state would mask actor-isolation regressions (e.g., a leaked group
 * membership from a prior run masking a missing addMember call).
 */
test.describe("two-tab collaborative editing", () => {
  test("text typed in tab 1 appears in tab 2 within a few seconds", async ({ browser }) => {
    const drew = await browser.newContext();
    const alice = await browser.newContext();

    const drewPage = await drew.newPage();
    const alicePage = await alice.newPage();

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
