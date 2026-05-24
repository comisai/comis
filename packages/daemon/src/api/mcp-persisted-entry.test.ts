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
