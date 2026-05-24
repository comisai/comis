// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link buildPersistedMcpEntry} — the CR-01 single-source-of-truth
 * for which per-server fields survive an mcp.connect persist round-trip.
 *
 * Phase 66 (OAUTH-10/11) adds `auth`/`oauth`. They are config-only on the
 * mcp.connect path (no RPC params), so — exactly like the Phase 65/67
 * tool-filter / parallel-calls fields — their only source on a reconnect /
 * re-add is the input. Dropping them is a security regression (T-66-02): a
 * server silently loses its `auth:"oauth"` requirement (downgrade to no-auth).
 * These tests pin the conditional-spread so the regression cannot recur.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { McpServerEntry } from "@comis/core";
import { buildPersistedMcpEntry } from "./mcp-persisted-entry.js";

// Minimal valid base input — the schema-inferred McpServerEntry requires
// name/transport/enabled/idleTtlMs; buildPersistedMcpEntry always sets
// enabled:true + idleTtlMs itself, so the input only carries serverName +
// transport + disablePlaintextSecretCheck (the always-present fields).
const baseInput = {
  serverName: "notion",
  transport: "http" as const,
  url: "https://mcp.notion.com/mcp",
  disablePlaintextSecretCheck: false,
} as const;

describe("buildPersistedMcpEntry — Phase 66 auth/oauth persistence (CR-01 / T-66-02)", () => {
  it("persists auth AND oauth when supplied (not stripped)", () => {
    const entry = buildPersistedMcpEntry({
      ...baseInput,
      auth: "oauth",
      oauth: { scope: "read", stripeAccount: "acct_1" },
      persistedEntry: undefined,
    });
    expect(entry.auth).toBe("oauth");
    expect(entry.oauth).toEqual({ scope: "read", stripeAccount: "acct_1" });
  });

  it("omits auth/oauth keys entirely when both are undefined (conditional spread, no undefined value)", () => {
    const entry = buildPersistedMcpEntry({
      ...baseInput,
      persistedEntry: undefined,
    });
    expect(Object.prototype.hasOwnProperty.call(entry, "auth")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, "oauth")).toBe(false);
  });

  it("preserves auth/oauth across a reconnect round-trip (output re-fed as persistedEntry)", () => {
    // First persist with auth/oauth set.
    const first = buildPersistedMcpEntry({
      ...baseInput,
      auth: "oauth",
      oauth: { authorizationEndpoint: "https://auth.example.com/authorize", scope: "read" },
      persistedEntry: undefined,
    });

    // Reconnect: mcp.connect has no auth/oauth params, so they arrive only via
    // the prior persisted entry. The CR-01 invariant: a no-param reconnect must
    // NOT strip them.
    const second = buildPersistedMcpEntry({
      serverName: first.name,
      transport: first.transport,
      url: first.url,
      disablePlaintextSecretCheck: false,
      persistedEntry: first as McpServerEntry,
    });

    expect(second.auth).toBe("oauth");
    expect(second.oauth).toEqual({
      authorizationEndpoint: "https://auth.example.com/authorize",
      scope: "read",
    });
  });

  it("prefers the directly-supplied auth/oauth over the persisted entry (current intent wins)", () => {
    const prior: McpServerEntry = {
      name: "notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      auth: "none",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;

    const entry = buildPersistedMcpEntry({
      ...baseInput,
      auth: "oauth",
      oauth: { scope: "write" },
      persistedEntry: prior,
    });

    expect(entry.auth).toBe("oauth");
    expect(entry.oauth).toEqual({ scope: "write" });
  });
});

// ---------------------------------------------------------------------------
// Phase 68 BUNDLE-04: _bundleSource + _bundleArchive forwarding.
//
// Differs from the OAuth fields above: bundle markers are INPUT-DRIVEN (not
// persistedEntry-fallback). A no-marker reconnect from a manual mcp.connect
// explicitly clears them so the audit record reflects operator-intent
// override. Closes the Assumption A6 gap from 68-RESEARCH.md / Plan-Time
// Risk 2 (without forwarding, _bundleSource never survives mcp.connect ->
// restart, breaking the resolver-driven provenance contract).
// ---------------------------------------------------------------------------

describe("buildPersistedMcpEntry — Phase 68 _bundleSource + _bundleArchive forwarding (BUNDLE-04 persist half)", () => {
  it("forwards _bundleSource verbatim from input to output", () => {
    const entry = buildPersistedMcpEntry({
      serverName: "x",
      transport: "stdio",
      command: "npx",
      disablePlaintextSecretCheck: false,
      _bundleSource: "my-skill",
    });
    expect(entry._bundleSource).toBe("my-skill");
  });

  it("forwards a recursive _bundleArchive (preserves the prior entry's _bundleSource)", () => {
    const archive: McpServerEntry = {
      name: "x",
      transport: "stdio",
      command: "npx",
      _bundleSource: "old-skill",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;

    const entry = buildPersistedMcpEntry({
      serverName: "x",
      transport: "http",
      url: "https://example.com/mcp",
      disablePlaintextSecretCheck: false,
      _bundleSource: "new-skill",
      _bundleArchive: archive,
    });

    expect(entry._bundleSource).toBe("new-skill");
    expect(entry._bundleArchive).toBeDefined();
    expect(entry._bundleArchive?.name).toBe("x");
    expect(entry._bundleArchive?._bundleSource).toBe("old-skill");
  });

  it("omits _bundleSource / _bundleArchive keys entirely when both are undefined (conditional spread)", () => {
    const entry = buildPersistedMcpEntry({
      serverName: "x",
      transport: "stdio",
      command: "npx",
      disablePlaintextSecretCheck: false,
    });
    expect(Object.prototype.hasOwnProperty.call(entry, "_bundleSource")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, "_bundleArchive")).toBe(false);
  });

  it("INPUT-DRIVEN semantic: does NOT preserve _bundleSource from persistedEntry when input._bundleSource is undefined (operator override clears the marker)", () => {
    // The deliberate semantic: bundle markers are NOT in the CR-01 fallback set.
    // A manual `mcp.connect` from the operator HAS overridden the bundle entry --
    // the persistedEntry's _bundleSource MUST be cleared so the audit reflects
    // operator intent. This contrasts with toolAllowlist/auth/oauth/rlimits
    // which DO fall back to persistedEntry to prevent accidental strip on a
    // no-param reconnect.
    const prior: McpServerEntry = {
      name: "x",
      transport: "stdio",
      command: "npx",
      _bundleSource: "auto-installed-by-yfinance-skill",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;

    const entry = buildPersistedMcpEntry({
      serverName: "x",
      transport: "stdio",
      command: "npx",
      disablePlaintextSecretCheck: false,
      persistedEntry: prior,
      // _bundleSource intentionally omitted -- this is a manual mcp.connect
    });

    expect(Object.prototype.hasOwnProperty.call(entry, "_bundleSource")).toBe(false);
  });
});
