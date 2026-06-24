// SPDX-License-Identifier: Apache-2.0
/**
 * F-OBS-2 (30uc-20260624): `extractWebResultMetadata` — the CONTENT-FREE
 * web_search / web_fetch grounding summary threaded onto the trajectory
 * `tool.result` so a "grounded in fetched results" predicate is verifiable from
 * `comis explain` without a DEBUG daemon-log grep. Pins: count + source HOSTS
 * only; NEVER titles / snippets / paths / queries / bodies; undefined for any
 * other tool or an unparseable result (the emit is unchanged for everything else).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { extractWebResultMetadata } from "./pi-event-bridge.js";

describe("extractWebResultMetadata (F-OBS-2)", () => {
  it("summarizes a web_search result as {resultCount, sorted unique hosts} from the `.details` payload", () => {
    const result = {
      content: [{ type: "text", text: "…" }],
      details: {
        count: 3,
        results: [
          { title: "A", url: "https://www.example.com/a?q=secret", description: "body" },
          { title: "B", url: "https://news.example.org/x/y/z", description: "body" },
          { title: "C", url: "https://www.example.com/c" },
        ],
      },
    };

    const meta = extractWebResultMetadata("web_search", result);

    expect(meta).toEqual({
      resultCount: 3,
      domains: ["news.example.org", "www.example.com"], // sorted, unique hosts
    });
  });

  it("is CONTENT-FREE — never echoes titles, snippets, paths, or query strings", () => {
    const result = {
      details: {
        results: [{ title: "SECRET TITLE", url: "https://host.test/secret/path?token=abc", description: "SNIPPET" }],
      },
    };

    const json = JSON.stringify(extractWebResultMetadata("web_search", result));
    expect(json).not.toMatch(/SECRET TITLE|SNIPPET|secret\/path|token=abc/);
    expect(json).toContain("host.test"); // the host only
  });

  it("summarizes a web_fetch result as resultCount 1 + the fetched host (finalUrl wins over url)", () => {
    const result = {
      details: { url: "https://start.test/p", finalUrl: "https://final.test/page?x=1", status: 200, text: "FULL PAGE BODY" },
    };

    const meta = extractWebResultMetadata("web_fetch", result);

    expect(meta).toEqual({ resultCount: 1, domains: ["final.test"] });
    expect(JSON.stringify(meta)).not.toMatch(/FULL PAGE BODY|\/page|x=1/);
  });

  it("reads a direct-shape payload too (no `.details` wrapper)", () => {
    const meta = extractWebResultMetadata("web_search", {
      results: [{ url: "https://direct.test/a" }],
    });
    expect(meta).toEqual({ resultCount: 1, domains: ["direct.test"] });
  });

  it("returns undefined for a non-web tool (the emit is unchanged for everything else)", () => {
    expect(extractWebResultMetadata("bash", { details: { results: [{ url: "https://x.test" }] } })).toBeUndefined();
    expect(extractWebResultMetadata("read", "some file content")).toBeUndefined();
  });

  it("returns undefined for an unparseable / shapeless result (never throws)", () => {
    expect(extractWebResultMetadata("web_search", null)).toBeUndefined();
    expect(extractWebResultMetadata("web_search", "not an object")).toBeUndefined();
    expect(extractWebResultMetadata("web_search", { details: {} })).toBeUndefined(); // no results[]
    expect(extractWebResultMetadata("web_fetch", { details: {} })).toBeUndefined(); // no url
  });

  it("skips malformed URLs in a web_search result rather than throwing", () => {
    const meta = extractWebResultMetadata("web_search", {
      details: { results: [{ url: "not a url" }, { url: "https://ok.test/x" }, { url: 123 }] },
    });
    // 3 results counted; only the one parseable host surfaces.
    expect(meta).toEqual({ resultCount: 3, domains: ["ok.test"] });
  });
});
