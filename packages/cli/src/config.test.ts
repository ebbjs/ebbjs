import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./config.ts";
import { removeProject, tempProject } from "./test-utils.ts";

describe("loadConfig", () => {
  const projects: string[] = [];

  const project = async (): Promise<string> => {
    const dir = await tempProject("config-");
    projects.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(projects.splice(0).map(removeProject));
  });

  it("uses the documented defaults when ebb.config.ts is absent", async () => {
    const cwd = await project();
    const config = await loadConfig(cwd);

    expect(config.url).toBe("http://localhost:4000");
    expect(config.functions).toEqual({
      dir: resolve(cwd, "functions"),
      typesOut: resolve(cwd, "src/ebb-functions.generated.ts"),
    });
    expect(config.configPath).toBeUndefined();
  });

  it("loads ebb.config.ts importing defineConfig from @ebbjs/server", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "ebb.config.ts"),
      `
        import { defineConfig } from "@ebbjs/server";

        export default defineConfig({
          url: "http://functions.test:4000",
          token: "admin-token",
          actor: "a_author",
          headers: { authorization: "Bearer actor" },
          functions: { dir: "fn", typesOut: "types/contract.ts" },
        });
      `,
      "utf8",
    );

    const config = await loadConfig(cwd);

    expect(config.url).toBe("http://functions.test:4000");
    expect(config.token).toBe("admin-token");
    expect(config.actor).toBe("a_author");
    expect(config.headers).toEqual({ authorization: "Bearer actor" });
    expect(config.functions.dir).toBe(resolve(cwd, "fn"));
    expect(config.functions.typesOut).toBe(resolve(cwd, "types/contract.ts"));
    expect(config.configPath).toBe(join(cwd, "ebb.config.ts"));
  });

  it("lets flags override config values", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "ebb.config.ts"),
      `export default { url: "http://from-config", token: "config-token", actor: "config-actor" };`,
      "utf8",
    );

    const config = await loadConfig(cwd, {
      url: "http://from-flag",
      token: "flag-token",
      actor: "flag-actor",
    });

    expect(config.url).toBe("http://from-flag");
    expect(config.token).toBe("flag-token");
    expect(config.actor).toBe("flag-actor");
  });

  it("honors an explicit config path", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "custom.config.ts"),
      `export default { url: "http://custom" };`,
      "utf8",
    );

    const config = await loadConfig(cwd, { config: "custom.config.ts" });

    expect(config.url).toBe("http://custom");
    expect(config.configPath).toBe(join(cwd, "custom.config.ts"));
  });

  it("rejects a default export that is not an object", async () => {
    const cwd = await project();
    await writeFile(join(cwd, "ebb.config.ts"), `export default 42;`, "utf8");

    await expect(loadConfig(cwd)).rejects.toThrow(ConfigError);
    await expect(loadConfig(cwd)).rejects.toThrow(/must default-export a config object/);
  });
});
