// SPDX-License-Identifier: Apache-2.0
// Proxy environment tests cover env precedence, EnvHttpProxyAgent options, and
// NO_PROXY host/port/CIDR matching.
// Ported from ~/projects/openclaw/src/infra/net/proxy-env.test.ts with
// NodeJS.ProcessEnv casts replaced by Record<string, string | undefined>.
import { describe, expect, it } from "vitest";
import {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  hasProxyEnvConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "./proxy-env.js";

describe("hasProxyEnvConfigured", () => {
  it.each([
    {
      name: "detects upper-case HTTP proxy values",
      env: { HTTP_PROXY: "http://upper-http.test:8080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "detects lower-case all_proxy values",
      env: { all_proxy: "socks5://proxy.test:1080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "ignores blank proxy values",
      env: { HTTP_PROXY: "   ", all_proxy: "" } as Record<string, string | undefined>,
      expected: false,
    },
  ])("$name", ({ env, expected }) => {
    expect(hasProxyEnvConfigured(env)).toBe(expected);
  });
});

describe("resolveEnvHttpProxyUrl", () => {
  it.each([
    {
      name: "uses lower-case https_proxy before upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "http://lower.test:8080",
        HTTPS_PROXY: "http://upper.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: "http://lower.test:8080",
      expectedConfigured: true,
    },
    {
      name: "treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "",
        HTTPS_PROXY: "http://upper.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "treats empty lower-case http_proxy as authoritative over upper-case HTTP_PROXY",
      protocol: "http" as const,
      env: {
        http_proxy: "   ",
        HTTP_PROXY: "http://upper-http.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "falls back from HTTPS proxy vars to HTTP proxy vars for https requests",
      protocol: "https" as const,
      env: {
        HTTP_PROXY: "http://upper-http.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: "http://upper-http.test:8080",
      expectedConfigured: true,
    },
    {
      name: "does not use ALL_PROXY for EnvHttpProxyAgent-style resolution",
      protocol: "https" as const,
      env: {
        ALL_PROXY: "http://all-proxy.test:8080",
        all_proxy: "http://lower-all-proxy.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "returns only HTTP proxies for http requests",
      protocol: "http" as const,
      env: {
        https_proxy: "http://lower-https.test:8080",
        http_proxy: "http://lower-http.test:8080",
      } as Record<string, string | undefined>,
      expectedUrl: "http://lower-http.test:8080",
      expectedConfigured: true,
    },
  ])("$name", ({ protocol, env, expectedUrl, expectedConfigured }) => {
    expect(resolveEnvHttpProxyUrl(protocol, env)).toBe(expectedUrl);
    expect(hasEnvHttpProxyConfigured(protocol, env)).toBe(expectedConfigured);
  });
});

describe("resolveEnvHttpProxyAgentOptions", () => {
  it.each([
    {
      name: "maps HTTPS_PROXY to httpsProxy only",
      env: { HTTPS_PROXY: "http://https-proxy.test:8443" } as Record<string, string | undefined>,
      expected: { httpsProxy: "http://https-proxy.test:8443" },
    },
    {
      name: "uses HTTP_PROXY as HTTPS fallback",
      env: { HTTP_PROXY: "http://http-proxy.test:8080" } as Record<string, string | undefined>,
      expected: {
        httpProxy: "http://http-proxy.test:8080",
        httpsProxy: "http://http-proxy.test:8080",
      },
    },
    {
      name: "uses ALL_PROXY for both protocols",
      env: { ALL_PROXY: "socks5://all-proxy.test:1080" } as Record<string, string | undefined>,
      expected: {
        httpProxy: "socks5://all-proxy.test:1080",
        httpsProxy: "socks5://all-proxy.test:1080",
      },
    },
    {
      name: "lets protocol-specific proxy override ALL_PROXY",
      env: {
        ALL_PROXY: "socks5://all-proxy.test:1080",
        HTTP_PROXY: "http://http-proxy.test:8080",
        HTTPS_PROXY: "http://https-proxy.test:8443",
      } as Record<string, string | undefined>,
      expected: {
        httpProxy: "http://http-proxy.test:8080",
        httpsProxy: "http://https-proxy.test:8443",
      },
    },
    {
      name: "treats empty lower-case all_proxy as authoritative over upper-case ALL_PROXY",
      env: {
        all_proxy: "",
        ALL_PROXY: "socks5://upper-all-proxy.test:1080",
      } as Record<string, string | undefined>,
      expected: undefined,
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveEnvHttpProxyAgentOptions(env)).toEqual(expected);
    expect(hasEnvHttpProxyAgentConfigured(env)).toBe(expected !== undefined);
  });
});

describe("matchesNoProxy", () => {
  it.each([
    {
      name: "returns false when no NO_PROXY is set",
      url: "https://api.openai.com/v1/chat",
      env: {} as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "returns false for blank NO_PROXY",
      url: "https://api.openai.com",
      env: { NO_PROXY: "   " } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "matches wildcard",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "*" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches apex hostnames for leading-dot entries",
      url: "https://openai.com/v1/chat",
      env: { NO_PROXY: ".openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches apex hostnames for wildcard-dot entries",
      url: "https://openai.com/v1/chat",
      env: { NO_PROXY: "*.openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "does not treat wildcard entries inside a list as global bypass",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "localhost,*" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "matches exact hostname",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "api.openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches subdomain via leading-dot normalization",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: ".openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches subdomain suffix without leading dot",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "does not match unrelated hostname",
      url: "https://api.example.org/v1/chat",
      env: { NO_PROXY: "openai.com" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "does not match when suffix is not a domain boundary",
      url: "https://notopenai.com/v1",
      env: { NO_PROXY: "openai.com" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "respects port in NO_PROXY entry",
      url: "https://api.internal:8443/v1",
      env: { NO_PROXY: "api.internal:8443" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "does not match when port differs",
      url: "https://api.internal:9000/v1",
      env: { NO_PROXY: "api.internal:8443" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "is case-insensitive",
      url: "https://API.OpenAI.COM/v1",
      env: { no_proxy: "api.openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "parses comma-separated list",
      url: "https://internal.corp.example",
      env: { NO_PROXY: "localhost,127.0.0.1,internal.corp.example" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "parses whitespace-separated list (undici tokenizes on [,\\s])",
      url: "https://foo.corp.internal",
      env: { NO_PROXY: "localhost *.corp.internal" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "parses mixed comma-and-whitespace list",
      url: "https://api.openai.com",
      env: { NO_PROXY: "localhost, 127.0.0.1\tapi.openai.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "tab and newline act as delimiters",
      url: "https://internal.example",
      env: { NO_PROXY: "localhost\n127.0.0.1\tinternal.example" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches subdomain via *. wildcard normalization",
      url: "https://foo.example.com/v1",
      env: { NO_PROXY: "*.example.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "wildcard *.example.com matches bare example.com (undici normalizes to base domain)",
      url: "https://example.com/v1",
      env: { NO_PROXY: "*.example.com" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "*. wildcard respects port",
      url: "https://api.corp.internal:8443",
      env: { NO_PROXY: "*.corp.internal:8443" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "*. wildcard does not match unrelated suffix",
      url: "https://api.example.org",
      env: { NO_PROXY: "*.example.com" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "lower-case no_proxy is honored",
      url: "https://corp.local",
      env: { no_proxy: "corp.local" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches bracketed IPv6 literal",
      url: "http://[::1]:8080/health",
      env: { NO_PROXY: "[::1]:8080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches bare IPv6 literal",
      url: "http://[::1]:8080/health",
      env: { NO_PROXY: "::1" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches IPv4 CIDR entries",
      url: "http://100.64.0.3:8990/v1/messages",
      env: { NO_PROXY: "100.64.0.0/10" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches IPv4 wildcard octet entries",
      url: "http://100.64.0.3:8990/v1/messages",
      env: { NO_PROXY: "100.64.*" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "matches IPv4 wildcard octets one octet at a time",
      url: "http://8.1.8.8:8990/v1/messages",
      env: { NO_PROXY: "8.*.8.8" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "does not let non-final IPv4 wildcards ignore remaining octets",
      url: "http://8.1.2.3:8990/v1/messages",
      env: { NO_PROXY: "8.*.8.8" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "does not match IPv4 CIDR outside range",
      url: "http://100.128.0.3:8990/v1/messages",
      env: { NO_PROXY: "100.64.0.0/10" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "returns false for malformed target URL",
      url: "not-a-url",
      env: { NO_PROXY: "*" } as Record<string, string | undefined>,
      expected: false,
    },
  ])("$name", ({ url, env, expected }) => {
    expect(matchesNoProxy(url, env)).toBe(expected);
  });
});

describe("shouldUseEnvHttpProxyForUrl", () => {
  it.each([
    {
      name: "uses HTTPS_PROXY for https URLs",
      url: "https://api.example.com/v1",
      env: { HTTPS_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "falls back to HTTP_PROXY for https URLs",
      url: "https://api.example.com/v1",
      env: { HTTP_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "uses HTTP_PROXY for http URLs",
      url: "http://api.example.com/v1",
      env: { HTTP_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: true,
    },
    {
      name: "ignores ALL_PROXY-only environments",
      url: "https://api.example.com/v1",
      env: { ALL_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for NO_PROXY matches",
      url: "https://internal.corp.example/v1",
      env: {
        HTTPS_PROXY: "http://proxy.test:8080",
        NO_PROXY: "corp.example",
      } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for NO_PROXY CIDR matches",
      url: "http://100.64.0.3:8990/v1/messages",
      env: {
        HTTP_PROXY: "http://proxy.test:8080",
        NO_PROXY: "100.64.0.0/10",
      } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for NO_PROXY IP wildcard matches",
      url: "http://100.64.0.3:8990/v1/messages",
      env: {
        HTTP_PROXY: "http://proxy.test:8080",
        NO_PROXY: "100.64.*",
      } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for bare IPv6 NO_PROXY matches",
      url: "http://[::1]:11434/v1",
      env: {
        HTTP_PROXY: "http://proxy.test:8080",
        NO_PROXY: "::1",
      } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for non-http URLs",
      url: "file:///tmp/input.txt",
      env: { HTTPS_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: false,
    },
    {
      name: "keeps strict mode for malformed URLs",
      url: "not-a-url",
      env: { HTTPS_PROXY: "http://proxy.test:8080" } as Record<string, string | undefined>,
      expected: false,
    },
  ])("$name", ({ url, env, expected }) => {
    expect(shouldUseEnvHttpProxyForUrl(url, env)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage for matchesNoProxy internal helpers
// These cover edge cases in matchesIpv4NoProxyPattern not reached by the main
// test matrix (lines 277, 284, 289 in proxy-env.ts).
// ---------------------------------------------------------------------------

describe("matchesNoProxy branch coverage", () => {
  it("does NOT match when NO_PROXY entry is a malformed CIDR (invalid network address)", () => {
    // Covers line 277: network === undefined when CIDR network IP is bad
    // "999.999.0.0/16" parses the octet 999 as invalid → network=undefined → return false
    const env = { NO_PROXY: "999.999.0.0/16" };
    // 10.0.0.1 should not match a malformed CIDR
    expect(matchesNoProxy("http://10.0.0.1", env)).toBe(false);
  });

  it("does NOT match when NO_PROXY entry has no wildcard and is not a CIDR (non-IP string)", () => {
    // Covers line 284: no wildcard, not a CIDR → returns false for IP targets
    // Entry "nocidr" has no `*` and is not a CIDR — falls to `return false`
    // when target is an IPv4 address (matchesIpv4NoProxyPattern called on "10.0.0.1")
    const env = { NO_PROXY: "nocidr" };
    expect(matchesNoProxy("http://10.0.0.1", env)).toBe(false);
  });

  it("does NOT match when NO_PROXY wildcard pattern has more than 4 octets", () => {
    // Covers line 289: patternParts.length > 4 → return false
    const env = { NO_PROXY: "1.2.3.4.5.*" };
    expect(matchesNoProxy("http://10.0.0.1", env)).toBe(false);
  });

  it("uses no_proxy (lowercase) when both no_proxy and NO_PROXY are set", () => {
    // Covers line 159: no_proxy takes precedence over NO_PROXY
    const env = { no_proxy: "example.com", NO_PROXY: "other.com" };
    expect(matchesNoProxy("http://example.com", env)).toBe(true);
    expect(matchesNoProxy("http://other.com", env)).toBe(false);
  });
});
