import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isWildcardOrigin, normalizeOrigin } from "./apps.ts";

interface OriginVector {
  readonly raw: string;
  readonly canonical?: string;
  readonly invalid_reason?: string;
}

/// Resolved from this module rather than the cwd, so the run's directory does not matter.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/origin_vectors.json", import.meta.url));
const VECTORS = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { vectors: OriginVector[] }).vectors;

describe("normalizeOrigin", () => {
  it("canonicalizes scheme, host, default port, and a trailing slash", () => {
    expect(normalizeOrigin("HTTPS://App.Example.com:443/")).toBe("https://app.example.com");
    expect(normalizeOrigin("http://app.example.com:80")).toBe("http://app.example.com");
    expect(normalizeOrigin("  https://App.Example.com  ")).toBe("https://app.example.com");
  });

  it("keeps a non-default port and an IPv6 host", () => {
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeOrigin("http://[::1]:4000")).toBe("http://[::1]:4000");
    expect(normalizeOrigin("http://[::1]:80")).toBe("http://[::1]");
  });

  it("accepts a wildcard only as the whole leading host label", () => {
    expect(normalizeOrigin("https://*.example.com")).toBe("https://*.example.com");
    expect(isWildcardOrigin("https://*.example.com")).toBe(true);
    expect(isWildcardOrigin("https://example.com")).toBe(false);
    expect(normalizeOrigin("https://example.*.com")).toBeUndefined();
    expect(normalizeOrigin("https://*")).toBeUndefined();
    expect(normalizeOrigin("*")).toBeUndefined();
  });

  it("rejects anything that is not a bare http(s) origin", () => {
    for (const raw of [
      "",
      "   ",
      "null",
      "NULL",
      "ftp://example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com//",
      "https://example.com?query=1",
      "https://example.com#fragment",
      "https://example.com:99999",
      "https://exa mple.com",
      "https://a..example.com",
      "https://-example.com",
    ]) {
      expect(normalizeOrigin(raw), raw).toBeUndefined();
    }
  });
});

describe("shared origin vectors", () => {
  it("loads a non-empty vector set", () => {
    expect(VECTORS.length).toBeGreaterThan(0);
  });

  it("normalizes or rejects every shared vector", () => {
    for (const vector of VECTORS) {
      const origin = normalizeOrigin(vector.raw);

      if (vector.canonical !== undefined) {
        expect(origin, vector.raw).toBe(vector.canonical);
      } else {
        expect(vector.invalid_reason, vector.raw).toBe("invalid_origin");
        expect(origin, vector.raw).toBeUndefined();
      }
    }
  });
});
