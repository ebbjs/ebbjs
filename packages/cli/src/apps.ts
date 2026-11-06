const SCHEMES = new Set(["http", "https"]);

const WILDCARD_PREFIX = "*.";
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_HOST_BYTES = 253;
const MAX_LABEL_BYTES = 63;

/**
 * Renders a browser origin in the canonical form the server stores, or
 * `undefined` when it is not a registrable browser origin.
 *
 * The CLI normalizes before it sends so a local typo fails without a request
 * and the printed origin is the one the server will hold: lowercase scheme and
 * host, no default port, no userinfo, path, query, or fragment. `null` is
 * rejected because an opaque origin cannot be matched.
 */
export function normalizeOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!SCHEMES.has(scheme)) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "" && url.pathname !== "/") return undefined;

  const host = canonicalHost(url.hostname.toLowerCase());
  if (host === undefined) return undefined;

  return `${scheme}://${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/** Whether a canonical origin, as returned by `normalizeOrigin`, admits every subdomain. */
export function isWildcardOrigin(origin: string): boolean {
  const schemeEnd = origin.indexOf("://");
  return schemeEnd !== -1 && origin.startsWith(WILDCARD_PREFIX, schemeEnd + 3);
}

function canonicalHost(host: string): string | undefined {
  if (host === "" || host === "*") return undefined;
  if (host.startsWith("[")) return host.endsWith("]") ? host : undefined;

  if (host.startsWith(WILDCARD_PREFIX)) {
    const suffix = host.slice(WILDCARD_PREFIX.length);
    return isDnsHost(suffix) ? host : undefined;
  }

  if (host.includes("*")) return undefined;
  return isDnsHost(host) ? host : undefined;
}

function isDnsHost(host: string): boolean {
  if (byteLength(host) > MAX_HOST_BYTES) return false;
  return host.split(".").every(isLabel);
}

function isLabel(label: string): boolean {
  return byteLength(label) <= MAX_LABEL_BYTES && LABEL.test(label);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
