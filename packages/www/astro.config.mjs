import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import netlify from "@astrojs/netlify";

export default defineConfig({
  site: "https://ebbjs.com",
  adapter: netlify(),
  image: { service: { entrypoint: "astro/assets/services/noop" } },
  vite: { plugins: [tailwindcss()] },
  markdown: {
    shikiConfig: {
      theme: "github-dark-default",
    },
  },
});
