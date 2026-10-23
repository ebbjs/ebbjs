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
        "memory/index": "./src/memory/index.ts",
        "indexeddb/index": "./src/indexeddb/index.ts",
        "replica/index": "./src/replica/index.ts",
        "types/index": "./src/types/index.ts",
      },
      name: "@ebbjs/storage",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
