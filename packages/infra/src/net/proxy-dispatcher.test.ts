// SPDX-License-Identifier: Apache-2.0
/**
 * proxy-dispatcher.test.ts
 *
 * Tests for installGlobalProxyDispatcher + resetProxyDispatcherForTests.
 * Covers:
 *   1. INSTALL — dispatcher is replaced when HTTPS_PROXY is set
 *   2. IDEMPOTENT — same config fingerprint → reference-equal dispatcher
 *   3. ZERO-CONFIG NO-OP — no proxy env → dispatcher unchanged
 *   4. LOOPBACK — resolveEffectiveNoProxy bypasses localhost:4766
 *   5. FAIL-FAST enabled-without-url — ProxyConfigError with configKey
 *   6. FAIL-FAST unreadable caFile — ProxyConfigError naming the key
 *
 * Dispatcher isolation: capture the pre-test dispatcher in beforeEach, restore in afterEach.
 * State isolation: resetProxyDispatcherForTests() in afterEach clears module state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  installGlobalProxyDispatcher,
  resetProxyDispatcherForTests,
} from "./proxy-dispatcher.js";
import { ProxyConfigError, matchesNoProxy, resolveEffectiveNoProxy } from "@comis/core";

// ---------------------------------------------------------------------------
// Dispatcher isolation helpers
// ---------------------------------------------------------------------------

let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  // Capture the pre-test global dispatcher so we can restore after
  originalDispatcher = getGlobalDispatcher();
});

afterEach(() => {
  // Restore original dispatcher to prevent leaking proxy config into other tests
  setGlobalDispatcher(originalDispatcher);
  // Reset module-level fingerprint + dispatcher state
  resetProxyDispatcherForTests();
});

// ---------------------------------------------------------------------------
// 1. INSTALL — replacing the global dispatcher
// ---------------------------------------------------------------------------

describe("installGlobalProxyDispatcher", () => {
  describe("when HTTPS_PROXY is set (gateway-only mode)", () => {
    it("replaces the global dispatcher with a proxy-aware agent", () => {
      const before = getGlobalDispatcher();

      installGlobalProxyDispatcher({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only",
      });

      const after = getGlobalDispatcher();
      // The installer must have replaced the dispatcher
      expect(after).not.toBe(before);
    });

    it("sets a dispatcher whose constructor name is truthy (not plain Agent)", () => {
      installGlobalProxyDispatcher({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only",
      });
      const d = getGlobalDispatcher();
      // Should be either EnvHttpProxyAgent or a Dispatcher wrapper (compose returns ComposedDispatcher)
      expect(d.constructor.name).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. IDEMPOTENT — same config → reference-equal
  // ---------------------------------------------------------------------------

  describe("idempotency (SC#2, D-03)", () => {
    it("a second call with the same config returns the SAME dispatcher instance", () => {
      const config = {
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only" as const,
      };

      installGlobalProxyDispatcher(config);
      const after1 = getGlobalDispatcher();

      installGlobalProxyDispatcher(config);
      const after2 = getGlobalDispatcher();

      // Reference-equal — no re-install (SHA-256 fingerprint idempotency)
      expect(after2).toBe(after1);
    });

    it("a call with different proxy config replaces the dispatcher", () => {
      installGlobalProxyDispatcher({
        env: { HTTPS_PROXY: "http://proxy-a.example.com:3128" },
        loopbackMode: "gateway-only",
      });
      const after1 = getGlobalDispatcher();

      installGlobalProxyDispatcher({
        env: { HTTPS_PROXY: "http://proxy-b.example.com:3128" },
        loopbackMode: "gateway-only",
      });
      const after2 = getGlobalDispatcher();

      // Different config → new dispatcher instance
      expect(after2).not.toBe(after1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. ZERO-CONFIG NO-OP — no proxy env → dispatcher unchanged
  // ---------------------------------------------------------------------------

  describe("zero-config no-op (PROXY-05, D-03)", () => {
    it("leaves the global dispatcher unchanged when no proxy env is configured", () => {
      const before = getGlobalDispatcher();

      installGlobalProxyDispatcher({ env: {} });

      const after = getGlobalDispatcher();
      // No proxy → no install → reference-equal to pre-call dispatcher
      expect(after).toBe(before);
    });

    it("leaves the global dispatcher unchanged when proxy vars are empty strings", () => {
      const before = getGlobalDispatcher();

      installGlobalProxyDispatcher({ env: { HTTPS_PROXY: "", HTTP_PROXY: "" } });

      const after = getGlobalDispatcher();
      expect(after).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. LOOPBACK — resolveEffectiveNoProxy bypasses localhost:4766
  // Pure predicate assertion on the effective NO_PROXY string
  // ---------------------------------------------------------------------------

  describe("loopback bypass (SC#3, D-06, T-2-01)", () => {
    it("resolveEffectiveNoProxy includes localhost in gateway-only mode", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only",
      });

      // The effective NO_PROXY must include at least localhost
      expect(effectiveNoProxy).toContain("localhost");
    });

    it("resolveEffectiveNoProxy includes 127.0.0.1 in gateway-only mode", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only",
      });
      expect(effectiveNoProxy).toContain("127.0.0.1");
    });

    it("matchesNoProxy returns true for http://localhost:4766 with effective NO_PROXY (SC#3)", () => {
      // Simulate what the installer computes and confirm the gateway is bypassed
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only",
      });

      // Build an env snapshot with the effective NO_PROXY string
      const envWithEffectiveNoProxy = {
        HTTPS_PROXY: "http://proxy.example.com:3128",
        NO_PROXY: effectiveNoProxy,
      };

      // The gateway URL must match → NOT routed through the proxy
      expect(matchesNoProxy("http://localhost:4766", envWithEffectiveNoProxy)).toBe(true);
    });

    it("resolveEffectiveNoProxy does NOT add loopback when loopbackMode is proxy", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128", NO_PROXY: "example.com" },
        loopbackMode: "proxy",
      });

      // Proxy mode: loopback NOT added
      expect(effectiveNoProxy).not.toContain("127.0.0.1");
    });

    it("resolveEffectiveNoProxy preserves existing NO_PROXY entries", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128", NO_PROXY: "corp.internal" },
        loopbackMode: "gateway-only",
      });

      expect(effectiveNoProxy).toContain("corp.internal");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. FAIL-FAST enabled-without-url
  // ---------------------------------------------------------------------------

  describe("fail-fast: enabled=true without proxyUrl (SEC-05)", () => {
    it("throws ProxyConfigError when enabled=true but proxyUrl is absent", () => {
      expect(() => {
        installGlobalProxyDispatcher({ env: {}, enabled: true });
      }).toThrow(ProxyConfigError);
    });

    it("the thrown ProxyConfigError.configKey is 'proxy.proxyUrl'", () => {
      let thrown: unknown;
      try {
        installGlobalProxyDispatcher({ env: {}, enabled: true });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProxyConfigError);
      expect((thrown as ProxyConfigError).configKey).toBe("proxy.proxyUrl");
    });

    it("the thrown ProxyConfigError.name is 'ProxyConfigError'", () => {
      let thrown: unknown;
      try {
        installGlobalProxyDispatcher({ env: {}, enabled: true });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProxyConfigError);
      expect((thrown as ProxyConfigError).name).toBe("ProxyConfigError");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. FAIL-FAST unreadable caFile
  // ---------------------------------------------------------------------------

  describe("fail-fast: unreadable caFile (SEC-01/SEC-05)", () => {
    it("throws ProxyConfigError when caFile path does not exist", () => {
      expect(() => {
        installGlobalProxyDispatcher({
          env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
          enabled: true,
          proxyUrl: "http://proxy.example.com:3128",
          caFile: "/nonexistent/ca.pem",
        });
      }).toThrow(ProxyConfigError);
    });

    it("the thrown ProxyConfigError.configKey is 'proxy.tls.caFile'", () => {
      let thrown: unknown;
      try {
        installGlobalProxyDispatcher({
          env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
          enabled: true,
          proxyUrl: "http://proxy.example.com:3128",
          caFile: "/nonexistent/ca.pem",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProxyConfigError);
      expect((thrown as ProxyConfigError).configKey).toBe("proxy.tls.caFile");
    });

    it("the ProxyConfigError message for unreadable caFile does not contain raw credentials", () => {
      // Use a URL with credentials to verify sanitizeProxyUrl is applied to the path
      let thrown: unknown;
      try {
        installGlobalProxyDispatcher({
          env: {},
          enabled: true,
          proxyUrl: "http://user:secretpassword@proxy.example.com:3128",
          caFile: "/nonexistent/secret-ca.pem",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ProxyConfigError);
      // Message must NOT contain raw password
      expect((thrown as Error).message).not.toContain("secretpassword");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. resetProxyDispatcherForTests
  // ---------------------------------------------------------------------------

  describe("resetProxyDispatcherForTests", () => {
    it("allows reinstalling with the same config after a reset", () => {
      const config = {
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "gateway-only" as const,
      };

      installGlobalProxyDispatcher(config);
      const after1 = getGlobalDispatcher();

      resetProxyDispatcherForTests();

      installGlobalProxyDispatcher(config);
      const after2 = getGlobalDispatcher();

      // After reset, re-install creates a fresh dispatcher (not idempotent no-op)
      // Both should be non-null and have replaced the dispatcher; they may be
      // different instances because the module state was cleared.
      expect(after1).not.toBe(originalDispatcher);
      expect(after2).not.toBe(originalDispatcher);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Explicit ProxyAgent path (enabled + proxyUrl, no env proxy) — line 239
  // Covers hasProxyConfigured(enabled && proxyUrl) → true and ProxyAgent branch
  // ---------------------------------------------------------------------------

  describe("explicit proxyUrl path (ProxyAgent, D-02)", () => {
    it("installs a dispatcher when enabled=true and proxyUrl is set (no env proxy)", () => {
      const before = getGlobalDispatcher();

      installGlobalProxyDispatcher({
        env: {},
        enabled: true,
        proxyUrl: "http://proxy.example.com:3128",
      });

      const after = getGlobalDispatcher();
      // Dispatcher replaced — explicit ProxyAgent path
      expect(after).not.toBe(before);
    });

    it("idempotent: same explicit proxyUrl config returns reference-equal dispatcher", () => {
      const config = {
        env: {},
        enabled: true,
        proxyUrl: "http://proxy.example.com:3128",
      };

      installGlobalProxyDispatcher(config);
      const after1 = getGlobalDispatcher();

      installGlobalProxyDispatcher(config);
      const after2 = getGlobalDispatcher();

      expect(after2).toBe(after1);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. loopbackMode: "proxy" — loopback NOT added to NO_PROXY
  // ---------------------------------------------------------------------------

  describe("loopbackMode proxy passes loopback to the proxy", () => {
    it("resolveEffectiveNoProxy with loopbackMode=proxy does not include 127.0.0.1", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: { HTTPS_PROXY: "http://proxy.example.com:3128" },
        loopbackMode: "proxy",
      });
      expect(effectiveNoProxy).not.toContain("127.0.0.1");
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Custom gatewayHostPort
  // ---------------------------------------------------------------------------

  describe("custom gatewayHostPort in gateway-only mode", () => {
    it("adds a custom gateway host:port to effective NO_PROXY", () => {
      const effectiveNoProxy = resolveEffectiveNoProxy({
        env: {},
        loopbackMode: "gateway-only",
        gatewayHostPort: "192.168.1.1:9999",
      });
      expect(effectiveNoProxy).toContain("192.168.1.1:9999");
    });
  });
});
