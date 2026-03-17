import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://ebbjs.com',
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  vite: { plugins: [tailwindcss()] },
  markdown: {
    shikiConfig: {
      theme: 'github-dark-default',
    },
  },
});
