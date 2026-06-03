// SPDX-License-Identifier: Apache-2.0
/**
 * Injection engine tests.
 *
 * Edge-case matrix:
 *   - empty rules → Authorization: Bearer <secret>  (default)
 *   - replaceHeader absent = no-op                  (security invariant)
 *   - setParam preserves verbatim query bytes        (raw-append, not re-encode)
 *   - CRLF in header name rejected by WHATWG Headers (tamper guard)
 *   - removeHeader operates case-insensitively
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { applyInjections } from "./injection-engine.js";
import type { InjectionInput } from "./injection-engine.js";
import type { InjectionRule } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_SECRET = "sk-ant-test-secret-value-42";

/** Build a fresh InjectionInput with optional pre-set headers and a given URL. */
function makeInput(
  url: string,
  headers: Record<string, string> = {},
): InjectionInput {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    h.set(k, v);
  }
  return { headers: h, url: new URL(url), secret: TEST_SECRET };
}

// ── applyInjections — default-Bearer ──────────────────────────────────────────

describe("applyInjections — default-Bearer", () => {
  it("injects Authorization: Bearer <secret> when no rules are provided", () => {
    const input = makeInput("https://api.example.com/v1");
    applyInjections([], input);
    expect(input.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET}`);
  });

  it("does not set other headers when using empty rules default", () => {
    const input = makeInput("https://api.example.com/v1");
    applyInjections([], input);
    // Only the authorization header should be present
    const entries: string[] = [];
    input.headers.forEach((_v, k) => entries.push(k));
    expect(entries).toEqual(["authorization"]);
  });
});

// ── applyInjections — setHeader ───────────────────────────────────────────────

describe("applyInjections — setHeader raw format", () => {
  it("sets the named header to the raw secret value", () => {
    const input = makeInput("https://finnhub.io/api/v1/quote");
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-api-key", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("x-api-key")).toBe(TEST_SECRET);
  });

  it("does not change any header other than the named one", () => {
    const input = makeInput("https://finnhub.io/api/v1/quote", {
      "content-type": "application/json",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-api-key", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("content-type")).toBe("application/json");
  });
});

describe("applyInjections — setHeader bearer format", () => {
  it("sets the named header to Bearer <secret>", () => {
    const input = makeInput("https://api.openai.com/v1/chat");
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "authorization", format: "bearer" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("authorization")).toBe(`Bearer ${TEST_SECRET}`);
  });
});

describe("applyInjections — setHeader with removeAuthorization", () => {
  it("sets the named header and removes the authorization header when removeAuthorization is true", () => {
    const input = makeInput("https://api.example.com/", {
      authorization: "Bearer old-token",
    });
    const rules: readonly InjectionRule[] = [
      {
        kind: "setHeader",
        name: "x-api-key",
        format: "raw",
        removeAuthorization: true,
      },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("x-api-key")).toBe(TEST_SECRET);
    expect(input.headers.has("authorization")).toBe(false);
  });

  it("does not remove authorization when removeAuthorization is false", () => {
    const input = makeInput("https://api.example.com/", {
      authorization: "Bearer old-token",
    });
    const rules: readonly InjectionRule[] = [
      {
        kind: "setHeader",
        name: "x-api-key",
        format: "raw",
        removeAuthorization: false,
      },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("authorization")).toBe(true);
  });

  it("does not remove authorization when removeAuthorization is absent", () => {
    const input = makeInput("https://api.example.com/", {
      authorization: "Bearer old-token",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-api-key", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("authorization")).toBe(true);
  });
});

describe("applyInjections — setHeader raw GitHub Basic pattern", () => {
  it("sets raw value verbatim without Base64-wrapping (caller constructs the value)", () => {
    const rawValue = "x-access-token:ghp_test_token_here";
    const input = makeInput("https://api.github.com/");
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "authorization", format: "raw" },
    ];
    // Use a custom secret that looks like a GitHub PAT value
    const customInput: InjectionInput = {
      headers: input.headers,
      url: input.url,
      secret: rawValue,
    };
    applyInjections(rules, customInput);
    expect(customInput.headers.get("authorization")).toBe(rawValue);
  });
});

// ── applyInjections — replaceHeader (security invariant) ──────────────────────

describe("applyInjections — replaceHeader when header is present", () => {
  it("replaces the header value when the header already exists", () => {
    const input = makeInput("https://api.example.com/", {
      "x-target": "old-value",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "replaceHeader", name: "x-target", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("x-target")).toBe(TEST_SECRET);
  });
});

describe("applyInjections — replaceHeader absent = no-op (critical security invariant)", () => {
  it("does not set the header when it is absent — no credential injection into unintended requests", () => {
    const input = makeInput("https://api.example.com/");
    const rules: readonly InjectionRule[] = [
      { kind: "replaceHeader", name: "x-target", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("x-target")).toBe(false);
  });

  it("does not touch other headers when replaceHeader target is absent", () => {
    const input = makeInput("https://api.example.com/", {
      "content-type": "application/json",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "replaceHeader", name: "x-missing", format: "raw" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("content-type")).toBe("application/json");
  });
});

// ── applyInjections — removeHeader ────────────────────────────────────────────

describe("applyInjections — removeHeader", () => {
  it("removes the named header when it is present", () => {
    const input = makeInput("https://api.example.com/", {
      authorization: "Bearer old-token",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "removeHeader", name: "authorization" },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("authorization")).toBe(false);
  });

  it("is a no-op when the named header is not present", () => {
    const input = makeInput("https://api.example.com/");
    const rules: readonly InjectionRule[] = [
      { kind: "removeHeader", name: "authorization" },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("authorization")).toBe(false);
  });
});

describe("applyInjections — removeHeader case-insensitive", () => {
  it("removes Authorization header set with capital A when rule uses lowercase 'authorization'", () => {
    const h = new Headers();
    h.set("Authorization", "Bearer capital-A-set");
    const input: InjectionInput = {
      headers: h,
      url: new URL("https://api.example.com/"),
      secret: TEST_SECRET,
    };
    const rules: readonly InjectionRule[] = [
      { kind: "removeHeader", name: "authorization" },
    ];
    applyInjections(rules, input);
    expect(input.headers.has("authorization")).toBe(false);
    expect(input.headers.has("Authorization")).toBe(false);
  });
});

// ── applyInjections — setParam ────────────────────────────────────────────────

describe("applyInjections — setParam delegates to applySetParam", () => {
  it("appends the query param to a URL with no existing query", () => {
    const input = makeInput("https://finnhub.io/api/v1/quote");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    expect(input.url.search).toBe(`?token=${encodeURIComponent(TEST_SECRET)}`);
  });

  it("preserves the URL fragment after setParam injection", () => {
    const input = makeInput("https://app.io/path#section");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "k" },
    ];
    applyInjections(rules, input);
    expect(input.url.hash).toBe("#section");
    expect(input.url.search).toBe(`?k=${encodeURIComponent(TEST_SECRET)}`);
  });
});

// ── applyInjections — multiple rules, cumulative ──────────────────────────────

describe("applyInjections — multiple rules are applied in declaration order", () => {
  it("applies setHeader and removeHeader in sequence so both take effect", () => {
    const input = makeInput("https://api.example.com/", {
      authorization: "Bearer old-token",
    });
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-api-key", format: "raw" },
      { kind: "removeHeader", name: "authorization" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("x-api-key")).toBe(TEST_SECRET);
    expect(input.headers.has("authorization")).toBe(false);
  });

  it("last-wins: two setHeader rules on same name — second value prevails", () => {
    const input = makeInput("https://api.example.com/");
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-target", format: "raw" },
      { kind: "setHeader", name: "x-target", format: "bearer" },
    ];
    applyInjections(rules, input);
    expect(input.headers.get("x-target")).toBe(`Bearer ${TEST_SECRET}`);
  });
});

// ── applyInjections — CRLF tamper guard ──────────────────────────────────────

describe("applyInjections — CRLF in header name rejected by WHATWG Headers", () => {
  it("CRLF injection via setHeader throws — Node 22 WHATWG Headers rejects invalid header names", () => {
    // Node 22 always throws on CRLF in header names
    // ("Headers.set: 'x-evil\nX-Injected' is an invalid header name.").
    // Assert unconditionally — the weakened either/or branch would silently
    // accept a hypothetical implementation that strips the CRLF and injects
    // with a sanitized name.
    const input = makeInput("https://api.example.com/");
    const rules: readonly InjectionRule[] = [
      { kind: "setHeader", name: "x-evil\r\nX-Injected", format: "raw" },
    ];
    expect(() => applyInjections(rules, input)).toThrow();
  });
});

// ── applySetParam — edge cases ────────────────────────────────────────────────

describe("applySetParam — no existing query", () => {
  it("creates the query string from scratch when URL has no query", () => {
    const input = makeInput("https://finnhub.io/api/v1/quote");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    expect(input.url.search).toBe(`?token=${encodeURIComponent(TEST_SECRET)}`);
  });
});

describe("applySetParam — existing query preserved verbatim", () => {
  it("appends the new param to an existing query without disturbing it", () => {
    const input = makeInput("https://finnhub.io/api/v1/quote?symbol=AAPL");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    expect(input.url.search).toBe(
      `?symbol=AAPL&token=${encodeURIComponent(TEST_SECRET)}`,
    );
  });

  it("existing query bytes preserved verbatim — percent-encoded slash is NOT double-encoded", () => {
    // The %2F must remain %2F after injection — not become %252F
    const originalUrl = "https://s3.amazonaws.com/obj?X-Amz-Signature=abc%2Fdef";
    const input = makeInput(originalUrl);
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    // The original %2F must survive verbatim
    expect(input.url.search).toContain("X-Amz-Signature=abc%2Fdef");
  });

  it("SIGNED_URL: full AWS pre-signed URL retains both existing params verbatim", () => {
    const signedUrl =
      "https://s3.amazonaws.com/bucket/obj?X-Amz-Signature=abc%2Fdef&X-Amz-Credential=AKIA%2F20240101";
    const input = makeInput(signedUrl);
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    expect(input.url.search).toContain("X-Amz-Signature=abc%2Fdef");
    expect(input.url.search).toContain("X-Amz-Credential=AKIA%2F20240101");
  });
});

describe("applySetParam — special characters in secret value are percent-encoded", () => {
  it("URL-encodes ampersand and equals in the injected secret value", () => {
    const specialSecret = "tok&en=1 2";
    const input: InjectionInput = {
      headers: new Headers(),
      url: new URL("https://api.example.com/"),
      secret: specialSecret,
    };
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "token" },
    ];
    applyInjections(rules, input);
    expect(input.url.search).toBe("?token=tok%26en%3D1%202");
  });
});

describe("applySetParam — fragment preservation", () => {
  it("preserves the URL fragment when URL has no existing query", () => {
    const input = makeInput("https://app.io/path#section");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "k" },
    ];
    applyInjections(rules, input);
    expect(input.url.hash).toBe("#section");
    expect(input.url.search).toBe(`?k=${encodeURIComponent(TEST_SECRET)}`);
  });

  it("preserves the URL fragment when URL has an existing query", () => {
    const input = makeInput("https://app.io/path?a=1#section");
    const rules: readonly InjectionRule[] = [
      { kind: "setParam", name: "k" },
    ];
    applyInjections(rules, input);
    expect(input.url.hash).toBe("#section");
    expect(input.url.search).toBe(`?a=1&k=${encodeURIComponent(TEST_SECRET)}`);
  });
});
