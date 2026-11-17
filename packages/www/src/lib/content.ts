import { getCollection, type CollectionEntry } from "astro:content";

// What the site may publish is decided here and nowhere else: devlog entries
// default to `published: false` so drafts stay private, docs default to
// `published: true`. Pages and OG cards both read the collections through these
// helpers, so a route that forgot the filter cannot ship an unpublished entry.

export async function getPosts(): Promise<CollectionEntry<"devlog">[]> {
  const posts = await getCollection("devlog", ({ data }) => data.published);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export async function getDocs(): Promise<CollectionEntry<"docs">[]> {
  return getCollection("docs", ({ data }) => data.published);
}
