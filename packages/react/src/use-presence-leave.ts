import { useClient } from "./context";
import { useLeaveOnPageHide } from "./use-leave-on-page-hide";

/**
 * Retract this session's presence when the page goes away.
 *
 * `<EbbProvider>` already calls this, so an app under the provider needs
 * nothing. Call it yourself only where the wiring is not the provider's — a
 * custom context, or a client the provider does not hold — inside a component
 * that stays mounted for the page's lifetime.
 *
 * See {@link useLeaveOnPageHide} for why the trigger is `pagehide` alone and
 * why closing the client does not leave.
 */
export function usePresenceLeave(): void {
  useLeaveOnPageHide(useClient());
}
