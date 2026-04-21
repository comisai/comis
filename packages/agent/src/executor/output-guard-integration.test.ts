// SPDX-License-Identifier: Apache-2.0
/**
 * OutputGuard active redaction integration tests.
 *
 * Tests the OutputGuard defense layer using real createOutputGuard() and
 * generateCanaryToken() -- verifying the same scan logic that PiExecutor
 * invokes at its 3 scan sites.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createOutputGuard, generateCanaryToken } from "@comis/core";

describe("OutputGuard active redaction", () => {
  const outputGuard = createOutputGuard();
  const canaryToken = generateCanaryToken("test-agent", "test-secret");

  // ---------------------------------------------------------------------------
  // Critical: blocked and redacted
  // ---------------------------------------------------------------------------

  it("redacts Anthropic API key", () => {
    const response = "Here is the key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA";
    const result = outputGuard.scan(response, { canaryToken });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:anthropic_key]");
      expect(result.value.sanitized).not.toContain("sk-ant-api03");
    }
  });

  it("detects canary token leakage", () => {
    const response = `The system uses token ${canaryToken} for verification`;
    const result = outputGuard.scan(response, { canaryToken });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:canary]");
      expect(result.value.sanitized).not.toContain(canaryToken);
    }
  });

  // ---------------------------------------------------------------------------
  // Warning: detected but NOT redacted
  // ---------------------------------------------------------------------------

  it("detects but does not redact warning-level JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const response = `Token: ${jwt}`;
    const result = outputGuard.scan(response, { canaryToken });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(false);
      expect(result.value.findings.length).toBeGreaterThan(0);
      expect(result.value.findings.some(f => f.severity === "warning")).toBe(true);
      // Warning-only: sanitized text unchanged
      expect(result.value.sanitized).toContain(jwt);
    }
  });

  // ---------------------------------------------------------------------------
  // Clean: no findings
  // ---------------------------------------------------------------------------

  it("reports clean scan when no patterns found", () => {
    const response = "Hello, how can I help you today?";
    const result = outputGuard.scan(response, { canaryToken });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(true);
      expect(result.value.findings.length).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Canary token generation
  // ---------------------------------------------------------------------------

  it("generates deterministic canary tokens for same inputs", () => {
    const token1 = generateCanaryToken("agent-a", "shared-secret");
    const token2 = generateCanaryToken("agent-a", "shared-secret");
    expect(token1).toBe(token2);
  });

  it("generates unique canary tokens per agent", () => {
    const token1 = generateCanaryToken("agent-a", "shared-secret");
    const token2 = generateCanaryToken("agent-b", "shared-secret");
    expect(token1).not.toBe(token2);
  });

  it("generates CTKN_ prefixed tokens", () => {
    expect(canaryToken).toMatch(/^CTKN_[0-9a-f]{16}$/);
  });
});
