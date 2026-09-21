import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // listen on 0.0.0.0 + ::1 — reachable via Tailscale IP
    port: 5173,
    strictPort: true,
    // Allow Host headers from any hostname. The demo is served over
    // the tailnet; vite's default host check would otherwise reject
    // requests with a non-localhost Host header (e.g. the magicDNS
    // name `vps` or the Tailscale IP literal).
    allowedHosts: true,
    // Proxy API routes to the local ebb_server. Lets the demo use
    // relative URLs (`/sync/...`, `/entities/...`) so it works the
    // same when accessed locally (http://localhost:5173) and when
    // proxied through tailscale serve (https://vps.tail9b3b6.ts.net).
    //
    // SSE note: vite's built-in proxy passes chunked text/event-stream
    // responses through fine. The earlier "SSE hangs" symptom
    // (every connection after the first failing with
    // `:already_started` because `SSEConnection` registered itself
    // with the global name `__MODULE__`) was a server-side bug. The
    // global-name registration was removed in `sse_connection.ex`;
    // the regression is now locked by the e2e two-tab test
    // (`examples/collaborative-text-demo/e2e/two-tab.spec.ts`), which
    // opens two simultaneous SSE subscribers and asserts the second
    // one both reaches "live" and receives the first tab's edits.
    proxy: {
      "/sync": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      "/entities": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
