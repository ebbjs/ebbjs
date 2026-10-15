import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // listen on 0.0.0.0 + ::1 — reachable from other devices
    port: 5173,
    strictPort: true,
    // The demo is reachable over a tailnet/proxy; vite's default host check
    // would otherwise reject the non-localhost Host header.
    allowedHosts: true,
    // Proxy API routes to the local ebb_server so the app can use
    // relative URLs (`/sync/...`, `/entities/...`) regardless of how it
    // is reached.
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
