/**
 * Secrets fix unit tests.
 *
 * Verifies createSecretsFixes produces advisory actions for SEC-SECRET
 * findings, skips non-secret findings, and critically verifies that
 * no credential values leak into error messages or preview output.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createSecretsFixes } from "./fix-secrets.js";
import type { SecurityFinding } from "../types.js";

describe("createSecretsFixes", () => {
  it("returns empty actions for empty findings array", () => {
    const actions = createSecretsFixes([]);

    expect(actions).toHaveLength(0);
  });

  it("creates advisory action for SEC-SECRET finding", async () => {
    const findings: SecurityFinding[] = [
      {
        category: "secrets-exposure",
        severity: "warning",
        message: "Plaintext API key found in config",
        remediation: "Move to .env",
        code: "SEC-SECRET-SK_KEY",
      },
    ];

    const actions = createSecretsFixes(findings);

    expect(actions).toHaveLength(1);
    expect(actions[0].code).toBe("SEC-SECRET-SK_KEY");
    expect(actions[0].description).toContain("Plaintext API key found in config");
    expect(actions[0].preview()).toContain("Cannot auto-remediate");
    expect(actions[0].preview()).toContain(".env");

    const result = await actions[0].apply();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Manual action required");
    }
  });

  it("creates advisory actions for multiple SEC-SECRET findings", () => {
    const findings: SecurityFinding[] = [
      {
        category: "secrets-exposure",
        severity: "warning",
        message: "API key found",
        remediation: "Move to .env",
        code: "SEC-SECRET-001",
      },
      {
        category: "secrets-exposure",
        severity: "warning",
        message: "Database password found",
        remediation: "Move to .env",
        code: "SEC-SECRET-002",
      },
    ];

    const actions = createSecretsFixes(findings);

    expect(actions).toHaveLength(2);
    expect(actions[0].code).toBe("SEC-SECRET-001");
    expect(actions[1].code).toBe("SEC-SECRET-002");
  });

  it("skips findings whose code does not start with SEC-SECRET", () => {
    const findings: SecurityFinding[] = [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config file is world-readable",
        remediation: "chmod 600",
        code: "SEC-PERM-001",
        path: "/tmp/config.yaml",
      },
      {
        category: "state-protection",
        severity: "warning",
        message: "Data dir missing",
        remediation: "Create dir",
        code: "SEC-STATE-001",
      },
    ];

    const actions = createSecretsFixes(findings);

    expect(actions).toHaveLength(0);
  });

  it("CRITICAL: apply() error message does NOT contain actual secret values", async () => {
    const secretValue = "sk-ABCDEF1234567890secretkey";
    const findings: SecurityFinding[] = [
      {
        category: "secrets-exposure",
        severity: "warning",
        message: `Plaintext API key detected: ${secretValue}`,
        remediation: "Move credentials to .env file",
        code: "SEC-SECRET-API_KEY",
      },
    ];

    const actions = createSecretsFixes(findings);

    expect(actions).toHaveLength(1);

    const result = await actions[0].apply();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The error message must NOT contain the actual secret
      expect(result.error.message).not.toContain(secretValue);
      expect(result.error.message).not.toContain("sk-ABCDEF");
      // It should contain generic guidance only
      expect(result.error.message).toContain("Manual action required");
      expect(result.error.message).toContain(".env");
    }
  });

  it("CRITICAL: preview() does NOT contain actual secret values", () => {
    const secretValue = "ghp_XYZ789SecretTokenValue";
    const findings: SecurityFinding[] = [
      {
        category: "secrets-exposure",
        severity: "warning",
        message: `GitHub token exposed: ${secretValue}`,
        remediation: "Move to .env",
        code: "SEC-SECRET-GH_TOKEN",
      },
    ];

    const actions = createSecretsFixes(findings);

    expect(actions).toHaveLength(1);
    const previewText = actions[0].preview();
    expect(previewText).not.toContain(secretValue);
    expect(previewText).not.toContain("ghp_XYZ789");
    expect(previewText).toContain("Cannot auto-remediate");
  });
});
