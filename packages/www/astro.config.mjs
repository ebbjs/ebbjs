import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ebbjs.com',
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
