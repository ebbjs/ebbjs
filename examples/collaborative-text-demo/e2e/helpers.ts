import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Shared helpers for the slice-4 e2e suite (#61).
 *
 * Every spec builds on the same scaffolding: open the demo in two
 * browser contexts under different actor identities, wait for both to
 * reach the "live" connection state, then exercise the scenario. This
 * file centralizes the boilerplate so the specs can focus on the
 * behavior under test.
 *
 * The "live" assertion is the same one used by the foundational
 * two-tab happy-path test (e2e/two-tab.spec.ts): wait for the badge
 * text "live" to become visible. Both tabs must reach it before any
 * interaction begins — a connection that hangs in "connecting" or
 * "reconnecting" would mask the actual scenario under test.
 */

/**
 * Boot the demo in two browser contexts under `?actor=<first>` and
 * `?actor=<second>` and wait for both to reach the "live" badge.
 *
 * Returns the contexts and pages so callers can drive the scenario.
 * The contexts are not auto-closed; callers must close them (or let
 * the test fixture close them).
 */
export async function openTwoActorTabs(
  browser: Browser,
  opts: { first: string; second: string },
): Promise<{
  firstCtx: BrowserContext;
  secondCtx: BrowserContext;
  firstPage: Page;
  secondPage: Page;
}> {
  const firstCtx = await browser.newContext();
  const secondCtx = await browser.newContext();
  const firstPage = await firstCtx.newPage();
  const secondPage = await secondCtx.newPage();

  await firstPage.goto(`/?actor=${opts.first}`);
  await secondPage.goto(`/?actor=${opts.second}`);

  await waitForLive(firstPage);
  await waitForLive(secondPage);

  return { firstCtx, secondCtx, firstPage, secondPage };
}

/**
 * Wait for the connection badge to show "live".
 *
 * Why wait for "live" rather than the broader `live|connecting|reconnecting`
 * regex: bootstrap briefly reads "connecting" before SSE actually connects.
 * A test that matches the broader regex can pass against the pre-SSE
 * state and miss a real connection bug.
 */
export async function waitForLive(page: Page): Promise<void> {
  await expect(page.getByText("live").first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Wait for the connection badge to show the given state ("reconnecting"
 * or "offline"). Generous timeout because some scenarios intentionally
 * slow the reconnect cadence.
 */
export async function waitForBadgeState(page: Page, state: string): Promise<void> {
  await expect(page.getByText(state).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Apply the given test config to every page the test will open. Must
 * be called BEFORE the page navigates so `window.__EBB_DEMO_TEST_CONFIG__`
 * is in place when `bootstrap()` runs.
 *
 * Used by tests that need to influence the demo's runtime behavior
 * (shorter reconnect backoff, exposing the TextDocument handle).
 */
export async function applyTestConfig(
  context: BrowserContext,
  config: Record<string, unknown>,
): Promise<void> {
  await context.addInitScript((cfg) => {
    (window as unknown as { __EBB_DEMO_TEST_CONFIG__?: unknown }).__EBB_DEMO_TEST_CONFIG__ = cfg;
  }, config);
}

/**
 * Type a unique sentinel into the editor identified by `.cm-content`.
 * Used by every spec that needs to verify a typed character round-trips
 * via SSE to a peer tab.
 */
export async function typeSentinel(page: Page, sentinel: string): Promise<void> {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("End");
  await editor.pressSequentially(sentinel);
}

/** Re-exported from @playwright/test so callers can `import { test } from "./helpers"`. */
export { test, expect };
