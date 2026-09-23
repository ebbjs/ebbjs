import { test, expect, applyTestConfig } from "./helpers";

test("debug presence", async ({ browser }) => {
  const ctxD = await browser.newContext();
  const ctxA = await browser.newContext();
  await applyTestConfig(ctxA, { exposeState: true });
  const drewPage = await ctxD.newPage();
  const alicePage = await ctxA.newPage();

  alicePage.on("console", (msg) => {
    if (msg.text().includes("presence sse")) console.log(`[alice] ${msg.text()}`);
  });

  await drewPage.goto("/?actor=drew");
  await alicePage.goto("/?actor=alice");
  await expect(drewPage.getByText("live").first()).toBeVisible({ timeout: 30_000 });
  await expect(alicePage.getByText("live").first()).toBeVisible({ timeout: 30_000 });

  // Wait for both tabs to fully bootstrap including presence stream open
  await drewPage.waitForTimeout(3000);
  await alicePage.waitForTimeout(3000);

  console.log("=== drew POSTs presence manually ===");
  const result = await drewPage.evaluate(async () => {
    const res = await fetch("/sync/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ebb-actor-id": "drew" },
      body: JSON.stringify({
        entity_id: "doc_demo",
        data: {
          anchorId: "test_run_anchor",
          anchorOffset: 0,
          headId: "test_run_anchor",
          headOffset: 0,
        },
      }),
    });
    return { status: res.status };
  });
  console.log("drew POST result:", JSON.stringify(result));

  await alicePage.waitForTimeout(2000);

  const alicePresence = await alicePage.evaluate(() => {
    return window.__EBB_DEMO_TEST_STATE__?.getPresenceEntries() ?? null;
  });
  console.log("alice presence entries:", JSON.stringify(alicePresence, null, 2));

  await ctxD.close();
  await ctxA.close();
});
