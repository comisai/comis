// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for oauth-tls-preflight.ts (Phase 10 R10-01).
 *
 * Pure-function tests using DI fetch seam — NO vi.mock, NO vi.useFakeTimers,
 * NO vi.spyOn. The `fetchImpl?: typeof fetch` option exists for exactly
 * this test surface.
 *
 * Coverage:
 *   1. Happy path (302 redirect = success)
 *   2. tls-cert classification via cause.code Set
 *   3. network classification (ECONNREFUSED is NOT in the TLS code set)
 *   4. tls-cert classification via message-pattern regex fallback
 *   5. Custom timeoutMs respected (smoke)
 *   6. Generic network error → network kind
 *   7. Defensive null-input fallback
 */

import { describe, it, expect } from "vitest";
import { runOAuthTlsPreflight } from "./oauth-tls-preflight.js";

describe("runOAuthTlsPreflight", () => {
  it("returns ok when fetch resolves (302 success path with redirect:manual)", async () => {
    const stubFetch = async () => new Response(null, { status: 302 });
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result).toEqual({ ok: true });
  });

  it("classifies UNABLE_TO_GET_ISSUER_CERT_LOCALLY as tls-cert via cause.code Set", async () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        message: "unable to get local issuer certificate",
      },
    });
    const stubFetch = async () => {
      throw error;
    };
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result).toEqual({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
  });

  it("classifies ECONNREFUSED as network (not in TLS_CERT_ERROR_CODES)", async () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:443" },
    });
    const stubFetch = async () => {
      throw error;
    };
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.code).toBe("ECONNREFUSED");
    }
  });

  it("classifies tls-cert via message-pattern regex when cause.code is absent", async () => {
    const error = new Error("self-signed certificate in certificate chain");
    const stubFetch = async () => {
      throw error;
    };
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("tls-cert");
      expect(result.code).toBeUndefined();
      expect(result.message).toBe("self-signed certificate in certificate chain");
    }
  });

  it("respects custom timeoutMs (smoke — does not assert wall clock)", async () => {
    const stubFetch = async () => new Response(null, { status: 302 });
    const result = await runOAuthTlsPreflight({
      fetchImpl: stubFetch as typeof fetch,
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: true });
  });

  it("classifies generic DNS error (EAI_AGAIN) as network", async () => {
    const error = new Error("EAI_AGAIN dns lookup failed");
    const stubFetch = async () => {
      throw error;
    };
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.message).toBe("EAI_AGAIN dns lookup failed");
    }
  });

  it("defensively handles null/non-object errors via String(error) fallback", async () => {
    const stubFetch = async () => {
      throw null;
    };
    const result = await runOAuthTlsPreflight({ fetchImpl: stubFetch as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.message).toBe("null");
    }
  });
});
