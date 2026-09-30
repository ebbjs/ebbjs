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
 * Each call isolates the test to a fresh group id (see
 * `isolateTestGroup/2`) so the two tabs share a doc without leaking
 * state from prior specs under `workers: 1`. Pass an explicit
 * `groupId` to share one across nested helpers within a test.
 *
 * Returns the contexts and pages so callers can drive the scenario.
 * The contexts are not auto-closed; callers must close them (or let
 * the test fixture close them).
 */
export async function openTwoActorTabs(
  browser: Browser,
  opts: { first: string; second: string; groupId?: string },
): Promise<{
  firstCtx: BrowserContext;
  secondCtx: BrowserContext;
  firstPage: Page;
  secondPage: Page;
  groupId: string;
}> {
  const firstCtx = await browser.newContext();
  const secondCtx = await browser.newContext();
  const groupId = await isolateTestGroup(firstCtx, opts.groupId);
  await isolateTestGroup(secondCtx, groupId);

  const firstPage = await firstCtx.newPage();
  const secondPage = await secondCtx.newPage();

  await firstPage.goto(`/?actor=${opts.first}`);
  await secondPage.goto(`/?actor=${opts.second}`);

  await waitForLive(firstPage);
  await waitForLive(secondPage);

  return { firstCtx, secondCtx, firstPage, secondPage, groupId };
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
 * Build a fresh, unique group id for a Playwright spec invocation.
 *
 * Each call returns a different id so tests that share the server's
 * action log under `workers: 1` don't cross-contaminate. The id is
 * scoped to a single test run via a random suffix; reusing one
 * across runs would defeat the purpose.
 *
 * Paired with `isolateTestGroup/2` below — most specs only need
 * `isolateTestGroup(context)` which combines this with `applyTestConfig`.
 */
export function freshGroupId(): string {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `grp_test_${suffix}`;
}

/**
 * Seed the demo with a fresh, isolated group for the given context.
 *
 * The bootstrap path reads `__EBB_DEMO_TEST_CONFIG__.groupId` and
 * seeds/joins that group instead of the shared `grp_demo`. Two tabs
 * in the same test invocation that call this with the same id end
 * up in the same group and see each other's writes; tabs from a
 * prior test run stay in their own groups.
 *
 * Returns the id so callers can echo it into assertions or names.
 */
export async function isolateTestGroup(
  context: BrowserContext,
  groupId: string = freshGroupId(),
): Promise<string> {
  await applyTestConfig(context, { groupId });
  return groupId;
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
