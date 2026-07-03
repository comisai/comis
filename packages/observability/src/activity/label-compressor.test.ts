// SPDX-License-Identifier: Apache-2.0
/**
 * label-compressor unit tests. Proves the pure, one-pass,
 * idempotent display-shortener for URLs / ISO timestamps / long mcp_ tool
 * names, and — critically — that it treats an already-redacted,
 * already-path-compacted string as a fixed point: it does NOT re-compact paths
 * (redactValue's job) and does NOT re-redact tokens (also redactValue's job).
 *
 * @module
 */
import { describe, expect, it } from "vitest";

import { compressLabel } from "./label-compressor.js";

/**
 * The per-category corpus. Each row is `[name, input, expected]`. The same
 * corpus drives the idempotency and never-grows table-tests below so every
 * category is provably a fixed point under a second pass.
 */
const CATEGORIES: ReadonlyArray<readonly [string, string, string]> = [
  // URLs — strip scheme + leading api./www. host label + leading version
  // segment + query/hash; keep host + last meaningful path segment.
  ["tavily v1 search url with query", "https://api.tavily.com/v1/search?q=foo&max=20", "tavily.com/search"],
  ["http url with www and version prefix", "http://www.example.com/v2/users/list", "example.com/list"],
  ["url with no path keeps bare host", "https://example.com", "example.com"],
  ["url with trailing slash keeps bare host", "https://api.openai.com/", "openai.com"],
  // Timestamps — ISO-8601 → HH:MM:SS (drop date / T / millis / Z).
  ["iso timestamp embedded in prose", "fetched at 2025-05-22T18:42:00.123Z", "fetched at 18:42:00"],
  ["iso timestamp without millis or zulu", "2025-01-02T03:04:05", "03:04:05"],
  // Long mcp_ tool names — mcp_<server>_<rest...> → "<server>: <rest words>".
  ["long mcp yfinance tool name", "mcp_yfinance_get_historical_quotes", "yfinance: get historical quotes"],
  ["short mcp tool name with single rest word", "mcp_notion_search", "notion: search"],
  // Fixed points — paths (redactValue already compacted) + non-mcp names.
  ["tilde-rooted compacted path", "~/comis/packages/foo/bar.ts", "~/comis/packages/foo/bar.ts"],
  ["two-segment relative path", "foo/bar.ts", "foo/bar.ts"],
  ["non-mcp tool name untouched", "web_search", "web_search"],
  // Redaction is upstream — the compressor never re-redacts.
  ["already-redacted token passes through", "<redacted>", "<redacted>"],
  ["secret-shaped string left to upstream", "token sk_live_abcd", "token sk_live_abcd"],
  // Trivial.
  ["empty string", "", ""],
  ["plain word", "done", "done"],
];

describe("compressLabel — per-category one-pass display shortening", () => {
  it.each(CATEGORIES)("compresses category: %s", (_name, input, expected) => {
    expect(compressLabel(input)).toBe(expected);
  });

  it("compresses the tavily v1 search url to host plus last segment", () => {
    expect(compressLabel("https://api.tavily.com/v1/search?q=foo&max=20")).toBe("tavily.com/search");
  });

  it("strips the scheme from a url that has no path or query", () => {
    expect(compressLabel("https://example.com")).toBe("example.com");
  });

  it("shortens an iso-8601 timestamp to hours minutes seconds only", () => {
    const out = compressLabel("fetched at 2025-05-22T18:42:00.123Z");
    expect(out).toContain("18:42:00");
    expect(out).not.toContain("2025-05-22");
    expect(out).not.toContain("T");
    expect(out).not.toContain(".123");
    expect(out).not.toContain("Z");
  });

  it("reshapes a long mcp tool name into server colon spaced words", () => {
    expect(compressLabel("mcp_yfinance_get_historical_quotes")).toBe("yfinance: get historical quotes");
  });

  it("leaves a non-mcp underscore tool name unchanged", () => {
    expect(compressLabel("web_search")).toBe("web_search");
  });
});

describe("compressLabel — path fixed point (never re-compact redactValue output)", () => {
  it("treats a tilde-rooted path as a fixed point and does not trim it", () => {
    // redactValue already produced this `~`-rooted form. The compressor MUST
    // NOT shrink it to `foo/bar.ts` — that second-pass shrink breaks idempotency.
    expect(compressLabel("~/comis/packages/foo/bar.ts")).toBe("~/comis/packages/foo/bar.ts");
  });

  it("treats a two-segment relative path as a fixed point", () => {
    expect(compressLabel("foo/bar.ts")).toBe("foo/bar.ts");
  });

  it("does not touch a bare home tilde root with a dotfile", () => {
    expect(compressLabel("~/.comis/config.yaml")).toBe("~/.comis/config.yaml");
  });
});

describe("compressLabel — no re-redaction (redactValue owns secret masking upstream)", () => {
  it("passes an already-redacted token through unchanged", () => {
    expect(compressLabel("<redacted>")).toBe("<redacted>");
  });

  it("leaves a secret-shaped substring untouched (no token regexes here)", () => {
    expect(compressLabel("token sk_live_abcd")).toBe("token sk_live_abcd");
    expect(compressLabel("ghp_0123456789abcdef")).toBe("ghp_0123456789abcdef");
  });
});

describe("compressLabel — idempotency across every compression category", () => {
  it.each(CATEGORIES)("is idempotent for category: %s", (_name, input) => {
    const once = compressLabel(input);
    expect(compressLabel(once)).toBe(once);
  });

  it("is idempotent across every compression category in one assertion", () => {
    for (const [, input] of CATEGORIES) {
      const once = compressLabel(input);
      expect(compressLabel(once)).toBe(once);
    }
  });
});

describe("compressLabel — output never grows relative to the input", () => {
  it.each(CATEGORIES)("never lengthens output for category: %s", (_name, input) => {
    expect(compressLabel(input).length).toBeLessThanOrEqual(input.length);
  });

  it("never grows on a long pathological input (ReDoS / never-grow guard)", () => {
    const long = `https://api.tavily.com/v1/search?${"q=foo&".repeat(2000)}max=20`;
    const out = compressLabel(long);
    expect(out.length).toBeLessThanOrEqual(long.length);
    expect(out).toBe("tavily.com/search");
  });
});

describe("compressLabel — hard-clamps to the 120-char schema cap", () => {
  it("clamps a label longer than 120 chars to at most 120, truncating the tail with an ellipsis", () => {
    // A label with no compressible shape (plain prose) that is far over the cap.
    // The ActivityEvent schema enforces defaultLabel.max(120); a longer label is
    // REJECTED by parseActivityEvent (a level-50 ERROR → the event is DROPPED).
    const long = "a very long activity label ".repeat(20); // ~540 chars
    const out = compressLabel(long);
    expect(out.length).toBeLessThanOrEqual(120);
    // The head is preserved; the truncation carries an ellipsis tail.
    expect(out.startsWith("a very long activity label")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a label at or under 120 chars untouched (clamp is a no-op below the cap)", () => {
    const exactly120 = "x".repeat(120);
    expect(compressLabel(exactly120)).toBe(exactly120);
    const short = "reading config";
    expect(compressLabel(short)).toBe(short);
  });

  it("is idempotent at the cap boundary (a clamped 120-char output is a fixed point)", () => {
    const long = "z".repeat(400);
    const once = compressLabel(long);
    expect(once.length).toBeLessThanOrEqual(120);
    expect(compressLabel(once)).toBe(once);
  });
});
