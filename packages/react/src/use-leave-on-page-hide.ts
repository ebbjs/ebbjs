import { useEffect } from "react";
import type { SyncClient } from "@ebbjs/client";

/**
 * Leave the client's presence when the page is going away.
 *
 * `pagehide` is the page's lifetime, not a component's: it fires when the
 * document is torn down or enters the back/forward cache, which no React
 * effect observes. That is why {@link EbbProvider} installs this itself
 * rather than leaving it to an app that may never have heard of `leave`.
 *
 * `client.close()` is deliberately not the trigger. Closing is local teardown
 * — an app may replace its client on a re-render, a dev server remounts the
 * tree, a route swap unmounts the provider — and none of those mean the actor
 * is gone. Only the page going away retracts the presence it announced, with
 * `keepalive` so the POST survives the document it was issued from; that flag
 * is best-effort, and the channel TTL is the backstop when it is lost.
 *
 * A hidden tab is not a leave either: `visibilitychange` fires on every tab
 * switch, and a peer who is merely looking elsewhere still has a cursor. That
 * case is covered by the channel's TTL, which ages a peer out without a
 * round-trip. A page entering the back/forward cache is not a leave either —
 * `pagehide` fires with `persisted` set, the document may be restored, and a
 * restored client re-announces nothing until it writes again, so retracting
 * here would show a false absence on Back. The TTL covers the page that never
 * returns. The leave is fire-and-forget: nothing awaits it, and a failure
 * costs a TTL.
 */
export function useLeaveOnPageHide(client: SyncClient): void {
  useEffect(() => {
    const leave = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      void client.presence.leave({ keepalive: true });
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [client]);
}
