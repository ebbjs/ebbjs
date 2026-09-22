// Regression test for #105. Setups the shared-context two-tab burst
// against the Caddy-served demo (HTTP/2). Without the Caddy fix, this
// fails with a 15s timeout — see
// docs/investigations/issue-105-shared-ctx-burst.md for the diagnosis.
//
// Skips (passes) if the Caddy URL isn't reachable, so it doesn't break
// CI for contributors who don't have the demo running over Tailscale.
import { test, expect } from "@playwright/test";

const CADDY_URL = process.env.EBB_CADDY_URL ?? "https://vps.tail9b3b6.ts.net:8443";

test("shared-context two-tab burst through Caddy (h2) — regression for #105", async ({
  browser,
}) => {
  // The default CADDY_URL points at the team's VPS deployment; CI and
  // contributors running locally don't have that reachable. Skip unless
  // EBB_CADDY_URL is explicitly set to *something reachable from this
  // machine*. See the README for how to run Caddy locally and set the
  // env var.
  test.skip(
    !process.env.EBB_CADDY_URL,
    "EBB_CADDY_URL not set; skipping HTTP/2 regression test. Run with EBB_CADDY_URL=https://your-host:port to enable (see examples/collaborative-text-demo/README.md).",
  );

  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const p1 = await ctx.newPage();
  const p2 = await ctx.newPage();

  await p1.goto(`${CADDY_URL}/?actor=drew`);
  await p2.goto(`${CADDY_URL}/?actor=alice`);
  await expect(p1.getByText("live").first()).toBeVisible({ timeout: 30_000 });
  await expect(p2.getByText("live").first()).toBeVisible({ timeout: 30_000 });

  await p1.locator(".cm-content").first().click();
  await p1.locator(".cm-content").first().press("End");
  for (let i = 0; i < 20; i++) {
    await p1.locator(".cm-content").first().pressSequentially("x");
  }

  await expect(p2.locator(".cm-content").first()).toContainText("x".repeat(20), {
    timeout: 15_000,
  });
});
