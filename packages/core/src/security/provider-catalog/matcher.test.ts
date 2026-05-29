// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { normalizeHost, hostRuleMatches, pathAllowed, resolveBinding } from "./matcher.js";

import type { BrokerBinding, HostRule } from "./types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeExactRule(host: string, overrides: Partial<HostRule> = {}): HostRule {
  return {
    pattern: { kind: "exact", host },
    inject: [],
    ...overrides,
  };
}

function makeSuffixRule(suffix: string, overrides: Partial<HostRule> = {}): HostRule {
  return {
    pattern: { kind: "suffix", suffix },
    inject: [],
    ...overrides,
  };
}

function makeBinding(rule: HostRule, secretRef = "test-secret"): BrokerBinding {
  return { hostRules: [rule], secretRef };
}

// ── normalizeHost ─────────────────────────────────────────────────────────────

describe("normalizeHost — port strip and lowercasing", () => {
  it("strips the port from a plain hostname:port authority", () => {
    expect(normalizeHost("api.anthropic.com:443")).toBe("api.anthropic.com");
  });

  it("lowercases mixed-case hostname without port", () => {
    expect(normalizeHost("API.Anthropic.COM")).toBe("api.anthropic.com");
  });

  it("strips FQDN trailing dot from a hostname ending with period", () => {
    expect(normalizeHost("api.anthropic.com.")).toBe("api.anthropic.com");
  });
});

describe("normalizeHost — IPv6 authority handling (T-02-04)", () => {
  it("extracts bare IPv6 address from bracketed IPv6 with port without port-split corruption", () => {
    expect(normalizeHost("[2606:4700::1]:443")).toBe("2606:4700::1");
  });

  it("strips brackets from bare bracketed IPv6 with no port", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
  });
});

describe("normalizeHost — edge inputs", () => {
  it("returns empty string for empty authority input", () => {
    expect(normalizeHost("")).toBe("");
  });

  it("lowercases a malformed bracketed IPv6 with no closing bracket rather than crashing", () => {
    // Covers the closeBracket === -1 branch (malformed input handled gracefully)
    expect(normalizeHost("[2001:db8::1")).toBe("[2001:db8::1");
  });
});

// ── hostRuleMatches ───────────────────────────────────────────────────────────

describe("hostRuleMatches — exact pattern", () => {
  it("matches when hostname equals the exact host value in the rule", () => {
    expect(hostRuleMatches(makeExactRule("api.anthropic.com"), "api.anthropic.com")).toBe(true);
  });

  it("rejects a hostname that is a subdomain of the exact host value", () => {
    expect(hostRuleMatches(makeExactRule("api.anthropic.com"), "evil.api.anthropic.com")).toBe(false);
  });

  it("rejects a hostname that differs from the exact host value by a leading subdomain", () => {
    expect(hostRuleMatches(makeExactRule("github.com"), "api.github.com")).toBe(false);
  });
});

describe("hostRuleMatches — suffix pattern (T-02-01, T-02-02)", () => {
  it("matches a hostname that is strictly longer than the suffix", () => {
    expect(
      hostRuleMatches(
        makeSuffixRule("-aiplatform.googleapis.com"),
        "us-central1-aiplatform.googleapis.com",
      ),
    ).toBe(true);
  });

  it("rejects the bare suffix itself because length is not strictly greater than suffix length", () => {
    // T-02-01: length-guard is mandatory — bare suffix must not match itself
    expect(
      hostRuleMatches(makeSuffixRule("-aiplatform.googleapis.com"), "-aiplatform.googleapis.com"),
    ).toBe(false);
  });

  it("rejects a hostname that contains the suffix string but not as a true suffix (mid-string containment)", () => {
    // T-02-02: endsWith required — mid-string containment must not pass
    expect(
      hostRuleMatches(makeSuffixRule(".amazonaws.com"), "notamazonaws.com.evil.com"),
    ).toBe(false);
  });

  it("rejects a hostname where the suffix appears as a non-terminal substring at the end of a different TLD", () => {
    expect(
      hostRuleMatches(makeSuffixRule(".amazonaws.com"), "amazonaws.com.evil.io"),
    ).toBe(false);
  });
});

// ── pathAllowed ───────────────────────────────────────────────────────────────

describe("pathAllowed — undefined pathPolicy allows all paths", () => {
  it("allows any path when the rule has no pathPolicy field set", () => {
    const rule = makeExactRule("example.com"); // pathPolicy: undefined
    expect(pathAllowed(rule, "/v1/messages")).toBe(true);
    expect(pathAllowed(rule, "/anything/goes/here")).toBe(true);
  });
});

describe("pathAllowed — wildcard glob pattern", () => {
  it("allows any path when pathPolicy contains the bare wildcard asterisk", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["*"] });
    expect(pathAllowed(rule, "/anything")).toBe(true);
  });
});

describe("pathAllowed — boundary glob /v1/*", () => {
  it("allows a path that starts with the prefix and has at least one trailing segment", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/*"] });
    expect(pathAllowed(rule, "/v1/messages")).toBe(true);
  });

  it("rejects a path that starts with the prefix literal but belongs to a different path namespace", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/*"] });
    expect(pathAllowed(rule, "/v1beta")).toBe(false);
  });

  it("rejects the prefix path itself without any trailing segment after the slash", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/*"] });
    expect(pathAllowed(rule, "/v1")).toBe(false);
  });
});

describe("pathAllowed — prefix glob /v1/messages*", () => {
  it("allows a path that starts with the literal prefix before the trailing asterisk", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/messages*"] });
    expect(pathAllowed(rule, "/v1/messages/123")).toBe(true);
  });
});

describe("pathAllowed — segment wildcard /repos/*/issues", () => {
  it("allows a path matching the pattern with exactly one wildcard segment", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/repos/*/issues"] });
    expect(pathAllowed(rule, "/repos/foo/issues")).toBe(true);
  });

  it("rejects a path with multiple segments where the pattern expects exactly one wildcard segment", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/repos/*/issues"] });
    expect(pathAllowed(rule, "/repos/foo/bar/issues")).toBe(false);
  });
});

describe("pathAllowed — query string stripping (T-02-05)", () => {
  it("allows a path with a query string when the path portion matches the boundary glob", () => {
    // T-02-05: query string must be stripped before comparison — /v1/x?token=LEAK matches /v1/*
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/*"] });
    expect(pathAllowed(rule, "/v1/x?token=LEAK")).toBe(true);
  });
});

describe("pathAllowed — exact path match in policy", () => {
  it("allows a path that exactly equals a pattern with no wildcard characters", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/status"] });
    expect(pathAllowed(rule, "/v1/status")).toBe(true);
  });

  it("rejects a path that does not exactly match the non-wildcard pattern", () => {
    const rule = makeExactRule("example.com", { pathPolicy: ["/v1/status"] });
    expect(pathAllowed(rule, "/v1/status/extra")).toBe(false);
  });
});

describe("pathAllowed — segment wildcard with insufficient path depth", () => {
  it("rejects a path missing the trailing suffix required by a mid-pattern segment wildcard", () => {
    // Covers the segmentEnd === -1 branch: path /repos/myrepo has no slash after the wildcard slot,
    // but the pattern /repos/*/issues requires /issues after the slot — so it must be rejected.
    const rule = makeExactRule("example.com", { pathPolicy: ["/repos/*/issues"] });
    expect(pathAllowed(rule, "/repos/myrepo")).toBe(false);
  });
});

describe("pathAllowed — empty pathPolicy fails-closed", () => {
  it("rejects all paths when the pathPolicy array is empty (deny-by-omission)", () => {
    const rule = makeExactRule("example.com", { pathPolicy: [] });
    expect(pathAllowed(rule, "/v1/messages")).toBe(false);
    expect(pathAllowed(rule, "/")).toBe(false);
  });
});

// ── resolveBinding ────────────────────────────────────────────────────────────

describe("resolveBinding — fail-closed for unknown host (T-02-03, INJECT-03)", () => {
  it("returns undefined when bindings list is empty and host is unknown", () => {
    expect(resolveBinding([], "evil.com", "/")).toBeUndefined();
  });

  it("returns undefined when the host does not match any binding rule in a non-empty bindings list", () => {
    const binding = makeBinding(makeExactRule("api.anthropic.com"));
    expect(resolveBinding([binding], "evil.com", "/")).toBeUndefined();
  });
});

describe("resolveBinding — path-scoped rule precedence over host-only rule", () => {
  it("selects the path-scoped rule over a host-only rule when both match the hostname", () => {
    const hostOnlyRule = makeExactRule("www.googleapis.com");
    const pathScopedRule = makeExactRule("www.googleapis.com", {
      pathPrefix: "/calendar/",
      pathPolicy: ["/calendar/*"],
    });
    const bindingA = makeBinding(hostOnlyRule, "host-only-secret");
    const bindingB = makeBinding(pathScopedRule, "calendar-secret");

    const result = resolveBinding([bindingA, bindingB], "www.googleapis.com", "/calendar/v3/events");
    expect(result).toBeDefined();
    expect(result?.binding.secretRef).toBe("calendar-secret");
  });
});

describe("resolveBinding — path-scoped miss returns undefined", () => {
  it("returns undefined when only path-scoped bindings exist but the path does not match", () => {
    const pathScopedRule = makeExactRule("www.googleapis.com", {
      pathPrefix: "/calendar/",
      pathPolicy: ["/calendar/*"],
    });
    const binding = makeBinding(pathScopedRule, "calendar-secret");

    expect(resolveBinding([binding], "www.googleapis.com", "/unknown/path")).toBeUndefined();
  });
});

describe("resolveBinding — host-only rule matches any path", () => {
  it("matches any path when the rule has no pathPrefix defined", () => {
    const rule = makeExactRule("api.example.com");
    const binding = makeBinding(rule, "example-secret");

    const result = resolveBinding([binding], "api.example.com", "/any/path/here");
    expect(result).toBeDefined();
    expect(result?.binding.secretRef).toBe("example-secret");
  });
});

describe("resolveBinding — first-match determinism with overlapping bindings", () => {
  it("resolves to the first matching binding when multiple bindings match the same host and path", () => {
    const ruleA = makeExactRule("api.example.com");
    const ruleB = makeExactRule("api.example.com");
    const bindingA = makeBinding(ruleA, "first-secret");
    const bindingB = makeBinding(ruleB, "second-secret");

    const result = resolveBinding([bindingA, bindingB], "api.example.com", "/v1/endpoint");
    expect(result).toBeDefined();
    expect(result?.binding.secretRef).toBe("first-secret");
  });
});

describe("resolveBinding — provider-agnostic hand-written binding without preset (INJECT-01)", () => {
  it("resolves a hand-written binding for an arbitrary host with no preset involved", () => {
    // INJECT-01: provider-agnostic — any host works with a raw BrokerBinding, no preset required
    const rule: HostRule = {
      pattern: { kind: "exact", host: "my-internal-api.example.com" },
      inject: [],
    };
    const binding: BrokerBinding = {
      hostRules: [rule],
      secretRef: "INTERNAL_API_TOKEN",
    };

    const result = resolveBinding([binding], "my-internal-api.example.com", "/api/v1/data");
    expect(result).toBeDefined();
    expect(result?.binding.secretRef).toBe("INTERNAL_API_TOKEN");
    expect(result?.rule.pattern).toEqual({ kind: "exact", host: "my-internal-api.example.com" });
  });
});
