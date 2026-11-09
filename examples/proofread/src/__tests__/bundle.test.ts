import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const exampleRoot = fileURLToPath(new URL("../..", import.meta.url));

const bundleMain = async (): Promise<string> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../main.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]?.text ?? "";
};

describe("the client bundle", () => {
  it("carries the generated function contract and no authoring or runner code", async () => {
    const code = await bundleMain();

    expect(code).toContain("proofreadDocument");
    expect(code).toContain("createClient");

    // `defineFunction`, the deployed context, and the handler itself live on
    // the server side of the contract; importing the generated map as types
    // must not pull any of them into the bundle. The app schema is shared
    // client data, so its values remain, but the authoring helpers it came
    // from are inlined away by the bundler.
    expect(code).not.toContain("defineFunction");
    expect(code).not.toContain("defineModel");
    expect(code).not.toContain("@ebbjs/server");
    expect(code).not.toContain("@ebbjs/functions-runtime");
    expect(code).not.toContain("createContext");
    expect(code).not.toContain("proofread.example.invalid");
  });

  it("imports the function module as a type only", async () => {
    const generated = await readFile(`${exampleRoot}/src/ebb-functions.generated.ts`, "utf8");

    expect(generated).toContain(
      'import type { proofreadDocument } from "../functions/proofreadDocument";',
    );
    expect(generated).not.toMatch(
      /import\s+(?!type\b)[^;]*from\s+"\.\.\/functions\/proofreadDocument"/,
    );
    expect(generated).not.toContain("defineFunction");
    expect(generated).not.toContain("@ebbjs/server");
  });
});
