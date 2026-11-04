import { defineConfig } from "@ebbjs/server";

/**
 * Deploy settings for the example.
 *
 * `token` is the server's admin deploy credential (`:functions, :admin_token`
 * in the server config) and never an invoke grant: the same actor still needs
 * `function.proofreadDocument` to call the deployed function.
 */
export default defineConfig({
  url: process.env.EBB_URL ?? "http://localhost:4000",
  token: process.env.EBB_ADMIN_TOKEN ?? "dev-deploy-token",
  actor: process.env.EBB_ACTOR_ID ?? "a_proofreader",
  functions: {
    typesOut: "src/ebb-functions.generated.ts",
  },
});
