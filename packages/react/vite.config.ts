import { defineConfig } from "vite";
import { externalizeDeps } from "vite-plugin-externalize-deps";
import dts from "vite-plugin-dts";
import tsconfigPaths from "vite-tsconfig-paths";
import checker from "vite-plugin-checker";

export default defineConfig({
  plugins: [
    externalizeDeps(),
    checker({ typescript: true }),
    tsconfigPaths(),
    dts({
      include: ["src/**/*"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/__tests__/**",
        "src/test-db/**",
        "src/test-helpers/**",
        "src/integration.test.ts",
        "src/example-usage.ts",
        "src/testing/**",
      ],
      outDir: "dist",
      rollupTypes: false,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: "./src/index.ts",
      },
      name: "@ebbjs/react",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
