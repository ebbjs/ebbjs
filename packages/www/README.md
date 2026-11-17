# @ebbjs/www

The ebb marketing site, docs, and devlog — Astro, deployed to Netlify
(`netlify.toml` builds with `pnpm --filter www build`).

## Content publishing

`src/lib/content.ts` owns what ships: `getPosts()` returns only devlog entries
with `published: true` (the frontmatter default is `false`, so drafts stay
private), `getDocs()` returns docs entries that are not `published: false`. The
listing pages, the entry pages, and the OG card endpoints all read through it.

## Environment

Both are public (inlined into the client bundle at build time) and optional.

| Variable               | Default                     | Purpose                                                            |
| ---------------------- | --------------------------- | ------------------------------------------------------------------ |
| `PUBLIC_GHOST_SITE`    | `https://www.drewlyton.com` | Ghost instance that backs the waitlist signup and author link.     |
| `PUBLIC_GHOST_VERSION` | `6.78`                      | `x-ghost-version` sent to Ghost members endpoints (the live site). |

Set them in the Netlify build environment (or a local `.env`) to point the site
at a staging Ghost instance.

## Commands

```sh
pnpm build    # astro build
pnpm dev      # astro dev
```
