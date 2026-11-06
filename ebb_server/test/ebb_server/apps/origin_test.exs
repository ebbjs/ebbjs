defmodule EbbServer.Apps.OriginTest do
  use ExUnit.Case, async: true

  alias EbbServer.Apps.Origin

  describe "normalize/1" do
    test "lowercases the scheme and host" do
      assert Origin.normalize("HTTPS://Example.COM") == {:ok, "https://example.com"}
      assert Origin.normalize("http://LOCALHOST") == {:ok, "http://localhost"}
    end

    test "strips the scheme's default port" do
      assert Origin.normalize("http://example.com:80") == {:ok, "http://example.com"}
      assert Origin.normalize("https://example.com:443") == {:ok, "https://example.com"}
    end

    test "keeps explicit non-default ports" do
      assert Origin.normalize("https://example.com:8443") == {:ok, "https://example.com:8443"}
      assert Origin.normalize("https://example.com:80") == {:ok, "https://example.com:80"}
      assert Origin.normalize("http://example.com:443") == {:ok, "http://example.com:443"}
    end

    test "accepts an empty path or exactly a root path, dropping it" do
      assert Origin.normalize("https://example.com") == {:ok, "https://example.com"}
      assert Origin.normalize("https://example.com/") == {:ok, "https://example.com"}
    end

    test "trims surrounding whitespace" do
      assert Origin.normalize("  https://example.com  ") == {:ok, "https://example.com"}
    end

    test "allows a wildcard as the whole first host label" do
      assert Origin.normalize("https://*.Example.com") == {:ok, "https://*.example.com"}

      assert Origin.normalize("https://*.example.com:8443") ==
               {:ok, "https://*.example.com:8443"}
    end

    test "handles IPv6 bracket form" do
      assert Origin.normalize("https://[::1]") == {:ok, "https://[::1]"}
      assert Origin.normalize("https://[::1]:8443/") == {:ok, "https://[::1]:8443"}
      assert Origin.normalize("http://[2001:DB8::1]:80") == {:ok, "http://[2001:db8::1]"}
    end

    test "rejects paths other than a bare root" do
      assert Origin.normalize("https://example.com/path") == {:error, :invalid_origin}
      assert Origin.normalize("https://example.com//") == {:error, :invalid_origin}
    end

    test "rejects query, fragment, userinfo and the null origin" do
      assert Origin.normalize("https://example.com?x=1") == {:error, :invalid_origin}
      assert Origin.normalize("https://example.com#frag") == {:error, :invalid_origin}
      assert Origin.normalize("https://user:pw@example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://@example.com") == {:error, :invalid_origin}
      assert Origin.normalize("null") == {:error, :invalid_origin}
    end

    test "rejects schemes other than http and https" do
      assert Origin.normalize("ftp://example.com") == {:error, :invalid_origin}
      assert Origin.normalize("ws://example.com") == {:error, :invalid_origin}
    end

    test "rejects malformed hosts and ports" do
      assert Origin.normalize("example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://") == {:error, :invalid_origin}
      assert Origin.normalize("https://example.com:abc") == {:error, :invalid_origin}
      assert Origin.normalize("https://exa mple.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://example..com") == {:error, :invalid_origin}
      assert Origin.normalize("https://-example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://example.com.") == {:error, :invalid_origin}
      assert Origin.normalize("https://[::1") == {:error, :invalid_origin}
    end

    test "rejects every wildcard form other than a leading whole label" do
      assert Origin.normalize("*") == {:error, :invalid_origin}
      assert Origin.normalize("https://*") == {:error, :invalid_origin}
      assert Origin.normalize("https://*.*.example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://foo*.example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://*example.com") == {:error, :invalid_origin}
      assert Origin.normalize("https://*.example.com/path") == {:error, :invalid_origin}
    end

    test "rejects non-binary input" do
      assert Origin.normalize(nil) == {:error, :invalid_origin}
      assert Origin.normalize(:origin) == {:error, :invalid_origin}
    end
  end

  describe "normalize_all/1" do
    test "canonicalizes a list in order" do
      assert Origin.normalize_all(["HTTPS://A.example.com:443", "http://b.example.com:80"]) ==
               {:ok, ["https://a.example.com", "http://b.example.com"]}
    end

    test "rejects an empty or non-list input" do
      assert Origin.normalize_all([]) == {:error, :invalid_origin}
      assert Origin.normalize_all(nil) == {:error, :invalid_origin}
    end

    test "rejects a repeat after normalization" do
      assert Origin.normalize_all(["https://a.example.com", "HTTPS://A.example.com/"]) ==
               {:error, :duplicate_origin}
    end

    test "rejects one invalid origin among valid ones" do
      assert Origin.normalize_all(["https://a.example.com", "null"]) ==
               {:error, :invalid_origin}
    end
  end

  describe "wildcard?/1" do
    test "reports whether the canonical origin carries a wildcard label" do
      assert Origin.wildcard?("https://*.example.com")
      assert Origin.wildcard?("https://*.example.com:8443")
      refute Origin.wildcard?("https://example.com")
      refute Origin.wildcard?("https://[::1]")
      refute Origin.wildcard?("not an origin")
    end
  end

  describe "match?/2" do
    test "matches identical canonical origins" do
      assert Origin.match?("https://example.com", "https://example.com")
      assert Origin.match?("http://example.com:8443", "http://example.com:8443")
      refute Origin.match?("https://example.com", "http://example.com")
      refute Origin.match?("https://example.com", "https://example.com:8443")
    end

    test "matches wildcard patterns against subdomains" do
      assert Origin.match?("https://a.example.com", "https://*.example.com")
      assert Origin.match?("https://a.b.example.com", "https://*.example.com")
    end

    test "does not match the parent domain itself" do
      refute Origin.match?("https://example.com", "https://*.example.com")
      refute Origin.match?("https://notexample.com", "https://*.example.com")
    end

    test "does not match a different scheme or effective port" do
      refute Origin.match?("http://a.example.com", "https://*.example.com")
      refute Origin.match?("https://a.example.com:8443", "https://*.example.com")
      refute Origin.match?("https://a.example.com:80", "https://*.example.com")

      assert Origin.match?("https://a.example.com:8443", "https://*.example.com:8443")
    end

    test "never matches an origin that itself carries a wildcard" do
      refute Origin.match?("https://*.example.com", "https://*.example.com")
      refute Origin.match?("https://*.a.example.com", "https://*.example.com")
    end

    test "returns false for invalid input instead of raising" do
      refute Origin.match?("null", "https://*.example.com")
      refute Origin.match?("https://example.com", "not an origin")
      refute Origin.match?(nil, "https://example.com")
      refute Origin.match?("https://example.com", nil)
    end
  end
end
