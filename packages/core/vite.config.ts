import { defineConfig } from "vite";
import { externalizeDeps } from "vite-plugin-externalize-deps";
import tsconfigPaths from "vite-tsconfig-paths";
import checker from "vite-plugin-checker";
import { bundleDeclarations } from "../../scripts/vite-plugin-bundle-declarations.mjs";

export default defineConfig({
  plugins: [
    externalizeDeps(),
    checker({ typescript: true }),
    bundleDeclarations(),
    tsconfigPaths(),
  ],
  build: {
    lib: {
      entry: {
        index: "./src/index.ts",
        "seed/index": "./src/seed/index.ts",
      },
      name: "@ebbjs/core",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
