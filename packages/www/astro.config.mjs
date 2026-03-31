import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import netlify from "@astrojs/netlify";
import react from "@astrojs/react";
import mdx from "@astrojs/mdx";

export default defineConfig({
  site: "https://ebbjs.com",
  adapter: netlify(),
  integrations: [react(), mdx()],
  image: { service: { entrypoint: "astro/assets/services/noop" } },
  vite: { plugins: [tailwindcss()] },
  markdown: {
    shikiConfig: {
      theme: "github-dark-default",
    },
  },
});
