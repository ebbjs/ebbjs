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
