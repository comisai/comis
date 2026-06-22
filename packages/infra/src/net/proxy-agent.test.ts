// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-agent.test.ts — specs for the three proxy-agent helpers (fail before the helpers exist).
 *
 * Tests:
 *   1. Proxy configured + ordinary host → resolveHttpsProxyAgent returns HttpsProxyAgent
 *   2. Proxy configured + ordinary host → resolveUndiciProxyAgent returns ProxyAgent
 *   3. Proxy configured + ordinary host → resolveProxyUrl returns full URL (credentials preserved)
 *   4. No proxy env → all three return undefined (zero-config)
 *   5. Host in NO_PROXY → all three return undefined
 *   6. SSRF-blocked host → all three return undefined
 *
 * No network calls. Env injected via explicit env records — mirrors proxy-env.test.ts patterns.
 */

import { describe, it, expect } from "vitest";
import {
  resolveHttpsProxyAgent,
  resolveUndiciProxyAgent,
  resolveProxyUrl,
} from "./proxy-agent.js";

// ---------------------------------------------------------------------------
// Shared env fixtures
// ---------------------------------------------------------------------------

/** Env with an HTTPS proxy configured pointing at a test host. */
const PROXY_ENV: Record<string, string | undefined> = {
  HTTPS_PROXY: "http://user:secret@proxy.example.com:3128",
};

/** Env with NO_PROXY excluding api.example.com. */
const NO_PROXY_ENV: Record<string, string | undefined> = {
  HTTPS_PROXY: "http://proxy.example.com:3128",
  NO_PROXY: "api.example.com",
};

/** Empty env — no proxy configured at all (zero-config). */
const EMPTY_ENV: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Test 1: resolveHttpsProxyAgent — returns HttpsProxyAgent for a proxied host
// ---------------------------------------------------------------------------

describe("resolveHttpsProxyAgent", () => {
  it("returns an HttpsProxyAgent instance when proxy is configured and host is not excluded", () => {
    const agent = resolveHttpsProxyAgent("api.telegram.org", PROXY_ENV);
    expect(agent).toBeDefined();
    // HttpsProxyAgent — verify by constructor name (no instanceof across pkg boundaries)
    expect(agent!.constructor.name).toBe("HttpsProxyAgent");
  });

  it("returns undefined when no proxy env is configured (zero-config D-12)", () => {
    const agent = resolveHttpsProxyAgent("api.telegram.org", EMPTY_ENV);
    expect(agent).toBeUndefined();
  });

  it("returns undefined when the target host is in NO_PROXY (T-5-03)", () => {
    const agent = resolveHttpsProxyAgent("api.example.com", NO_PROXY_ENV);
    expect(agent).toBeUndefined();
  });

  it("returns undefined when the target host is SSRF-blocked (T-5-01)", () => {
    // 169.254.169.254 is cloud metadata — isSsrfBlocked returns true
    const agent = resolveHttpsProxyAgent("169.254.169.254", PROXY_ENV);
    expect(agent).toBeUndefined();
  });

  it("returns undefined for loopback host 127.0.0.1 (SSRF-blocked)", () => {
    const agent = resolveHttpsProxyAgent("127.0.0.1", PROXY_ENV);
    expect(agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: resolveUndiciProxyAgent — returns ProxyAgent for a proxied host
// ---------------------------------------------------------------------------

describe("resolveUndiciProxyAgent", () => {
  it("returns a ProxyAgent instance when proxy is configured and host is not excluded", () => {
    const agent = resolveUndiciProxyAgent("discord.com", PROXY_ENV);
    expect(agent).toBeDefined();
    expect(agent!.constructor.name).toBe("ProxyAgent");
  });

  it("returns undefined when no proxy env is configured (zero-config D-12)", () => {
    const agent = resolveUndiciProxyAgent("discord.com", EMPTY_ENV);
    expect(agent).toBeUndefined();
  });

  it("returns undefined when the target host is in NO_PROXY (T-5-03)", () => {
    const agent = resolveUndiciProxyAgent("api.example.com", NO_PROXY_ENV);
    expect(agent).toBeUndefined();
  });

  it("returns undefined when the target host is SSRF-blocked (T-5-01)", () => {
    const agent = resolveUndiciProxyAgent("169.254.169.254", PROXY_ENV);
    expect(agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3: resolveProxyUrl — returns raw URL with credentials preserved
// ---------------------------------------------------------------------------

describe("resolveProxyUrl", () => {
  it("returns the raw proxy URL string (credentials included) for a proxied host", () => {
    const url = resolveProxyUrl("mail.example.com", PROXY_ENV);
    expect(url).toBeDefined();
    // Must contain the credential — imapflow/nodemailer need Proxy-Authorization
    expect(url).toContain("user:secret@");
    expect(url).toContain("proxy.example.com:3128");
  });

  it("returns undefined when no proxy env is configured (zero-config D-12)", () => {
    const url = resolveProxyUrl("mail.example.com", EMPTY_ENV);
    expect(url).toBeUndefined();
  });

  it("returns undefined when the target host is in NO_PROXY (T-5-03)", () => {
    const url = resolveProxyUrl("api.example.com", NO_PROXY_ENV);
    expect(url).toBeUndefined();
  });

  it("returns undefined when the target host is SSRF-blocked (T-5-01)", () => {
    const url = resolveProxyUrl("169.254.169.254", PROXY_ENV);
    expect(url).toBeUndefined();
  });
});
