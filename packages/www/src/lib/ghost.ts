// The Ghost site behind waitlist signups and the author link. The env overrides
// exist so a staging Ghost instance can be targeted without editing components;
// the defaults are the live site.
const GHOST_SITE = import.meta.env.PUBLIC_GHOST_SITE ?? "https://www.drewlyton.com";
const GHOST_VERSION = import.meta.env.PUBLIC_GHOST_VERSION ?? "6.78";

export function ghostUrl(path: string, { attribution = false } = {}): string {
  const url = new URL(path, GHOST_SITE);
  if (attribution) url.searchParams.set("ref", "ebb");
  return url.toString();
}

// Members endpoints answer the same way whatever version they are told, but the
// header is what a real Ghost frontend sends, so it is set once here rather than
// at each call site drifting apart.
export async function ghostFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("app-pragma", "no-cache");
  headers.set("x-ghost-version", GHOST_VERSION);

  return fetch(ghostUrl(path), { ...init, headers });
}
