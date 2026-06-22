// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for classifyProxyError and UNCOVERED_TRANSPORTS.
 *
 * All tests construct synthetic Error objects — zero network I/O.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { classifyProxyError, UNCOVERED_TRANSPORTS } from "./proxy-error-classify.js";

// ---------------------------------------------------------------------------
// classifyProxyError branch coverage
// ---------------------------------------------------------------------------

describe("classifyProxyError", () => {
  it("maps AbortError to proxy_timeout", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_timeout");
    expect(result.hint).toMatch(/network path/i);
  });

  it("maps cause.code ECONNREFUSED to proxy_unreachable", () => {
    const cause = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_unreachable");
    expect(result.hint).toMatch(/HTTPS_PROXY|HTTP_PROXY/);
  });

  it("maps cause.code ENOTFOUND to proxy_unreachable", () => {
    const cause = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_unreachable");
    expect(result.hint).toMatch(/HTTPS_PROXY|HTTP_PROXY/);
  });

  it("maps cause.code ETIMEDOUT to proxy_timeout", () => {
    const cause = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_timeout");
    expect(result.hint).toMatch(/network path/i);
  });

  it("maps cause.code CERT_HAS_EXPIRED to proxy_tls_error", () => {
    const cause = Object.assign(new Error("CERT_HAS_EXPIRED"), { code: "CERT_HAS_EXPIRED" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_tls_error");
    expect(result.hint).toMatch(/proxy\.tls\.caFile/);
  });

  it("maps cause.code CERT_UNTRUSTED to proxy_tls_error", () => {
    const cause = Object.assign(new Error("CERT_UNTRUSTED"), { code: "CERT_UNTRUSTED" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_tls_error");
  });

  it("maps cause.message containing 'certificate' to proxy_tls_error", () => {
    const cause = Object.assign(new Error("self-signed certificate"), {});
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_tls_error");
    expect(result.hint).toMatch(/proxy\.tls\.caFile/);
  });

  it("maps cause.message containing 'SSL' to proxy_tls_error", () => {
    const cause = Object.assign(new Error("SSL routines error"), {});
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_tls_error");
  });

  it("maps cause.message containing 'TLS' to proxy_tls_error", () => {
    const cause = Object.assign(new Error("TLS handshake failed"), {});
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_tls_error");
  });

  it("maps unknown code to proxy_unknown", () => {
    const cause = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_unknown");
  });

  it("maps error without cause to proxy_unknown", () => {
    const err = new Error("something unexpected happened");
    const result = classifyProxyError(err);
    expect(result.errorKind).toBe("proxy_unknown");
  });

  it("maps non-Error to proxy_unknown", () => {
    const result = classifyProxyError("just a string");
    expect(result.errorKind).toBe("proxy_unknown");
  });
});

// ---------------------------------------------------------------------------
// UNCOVERED_TRANSPORTS
// ---------------------------------------------------------------------------

describe("UNCOVERED_TRANSPORTS", () => {
  it("exports a non-empty readonly array", () => {
    expect(Array.isArray(UNCOVERED_TRANSPORTS)).toBe(true);
    expect(UNCOVERED_TRANSPORTS.length).toBeGreaterThan(0);
  });

  it("includes IRC raw TCP entry", () => {
    const irc = UNCOVERED_TRANSPORTS.find((t) => t.name === "IRC");
    expect(irc).toBeDefined();
    expect(irc?.reason).toMatch(/raw TCP/i);
  });

  it("includes Discord WS gateway entry", () => {
    const discord = UNCOVERED_TRANSPORTS.find((t) => t.name === "Discord WS");
    expect(discord).toBeDefined();
    expect(discord?.reason).toMatch(/WebSocket|WS/i);
  });

  // WhatsApp (Baileys) is covered by the undici ws-agent wiring.
  // It must NOT appear in UNCOVERED_TRANSPORTS after reconciliation.
  it("does NOT include WhatsApp (Baileys) — covered by 05-02 undici ws-agent wiring", () => {
    const wa = UNCOVERED_TRANSPORTS.find((t) => t.name === "WhatsApp (Baileys)");
    expect(wa).toBeUndefined();
  });

  it("includes signal-cli entry with env-covered note", () => {
    const signal = UNCOVERED_TRANSPORTS.find((t) => t.name === "signal-cli");
    expect(signal).toBeDefined();
    // signal-cli inherits process.env and is env-covered
    expect(signal?.reason).toMatch(/env|process\.env/i);
    expect(signal?.coveredInPhase).toBe("env-covered");
  });

  // IRC and Discord WS are accepted gaps (SOCKS-only / WS-level).
  // coveredInPhase must reflect the accepted-gap status, not a pending future phase.
  it("IRC entry is marked as an accepted gap (not a pending phase)", () => {
    const irc = UNCOVERED_TRANSPORTS.find((t) => t.name === "IRC");
    expect(irc).toBeDefined();
    expect(irc?.coveredInPhase).toMatch(/gap|accepted/i);
  });

  it("Discord WS entry is marked as an accepted gap (not a pending phase)", () => {
    const discord = UNCOVERED_TRANSPORTS.find((t) => t.name === "Discord WS");
    expect(discord).toBeDefined();
    expect(discord?.coveredInPhase).toMatch(/gap|accepted/i);
  });

  it("has exactly 3 entries after reconciliation (IRC gap, Discord WS gap, signal-cli env-covered)", () => {
    expect(UNCOVERED_TRANSPORTS).toHaveLength(3);
  });

  it("each entry has coveredInPhase property", () => {
    for (const t of UNCOVERED_TRANSPORTS) {
      expect(t).toHaveProperty("coveredInPhase");
    }
  });
});
