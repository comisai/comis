// SPDX-License-Identifier: Apache-2.0
// Unit tests for sanitizeProxyUrl (credential-strip) — SEC-04 / D-08 defence
// against proxy-credential leakage into logs and error messages.
//
// Moved here from @comis/infra alongside the implementation. The companion
// CREDENTIAL_KEYS-membership test (Pino redact-path) stays in
// packages/infra/src/net/sanitize.test.ts because it depends on
// @comis/observability, which @comis/core does not.
import { describe, expect, it } from "vitest";

import { sanitizeProxyUrl } from "./sanitize.js";

describe("sanitizeProxyUrl — credential strip (SEC-04 / D-08)", () => {
  it("strips userinfo and returns scheme://host:port for a full proxy URL", () => {
    const secret = "s3cr3t!";
    const result = sanitizeProxyUrl(`http://user:${secret}@proxy.corp:3128/path`);
    expect(result).not.toContain(secret);
    expect(result).toBe("http://proxy.corp:3128");
  });

  it("strips userinfo when only a username is present (no password)", () => {
    const result = sanitizeProxyUrl("http://user@proxy.corp:3128");
    expect(result).not.toContain("user");
    expect(result).toBe("http://proxy.corp:3128");
  });

  it("returns scheme://host:port without a trailing path when URL has none", () => {
    const result = sanitizeProxyUrl("https://proxy.example.com:8080");
    expect(result).toBe("https://proxy.example.com:8080");
  });

  it("returns scheme://host (no port) when port is absent", () => {
    const result = sanitizeProxyUrl("http://proxy.corp");
    expect(result).toBe("http://proxy.corp");
  });

  it("returns a safe non-throwing placeholder for a completely malformed URL", () => {
    const result = sanitizeProxyUrl("not-a-url-at-all");
    expect(() => sanitizeProxyUrl("not-a-url-at-all")).not.toThrow();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a safe placeholder for an empty string without throwing", () => {
    expect(() => sanitizeProxyUrl("")).not.toThrow();
    expect(typeof sanitizeProxyUrl("")).toBe("string");
  });
});
