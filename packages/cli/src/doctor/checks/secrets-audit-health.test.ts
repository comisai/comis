// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for secretsAuditHealthCheck.
 *
 * Covers:
 *   - fail finding when auditSecrets returns error-severity findings
 *   - warn finding when auditSecrets returns warn-severity findings
 *   - pass finding when auditSecrets returns empty array
 *   - skip finding when auditSecrets throws
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DoctorContext, DoctorFinding } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@comis/core", async () => {
  const actual =
    await vi.importActual<typeof import("@comis/core")>("@comis/core");
  return {
    ...actual,
    auditSecrets: vi.fn(),
  };
});

const core = await import("@comis/core");
const { secretsAuditHealthCheck } = await import("./secrets-audit-health.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseContext: DoctorContext = {
  configPaths: ["/tmp/test-comis/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secretsAuditHealthCheck", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns fail DoctorFinding when auditSecrets finds a plaintext secret in config", async () => {
    vi.mocked(core.auditSecrets).mockReturnValue([
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/tmp/test-comis/config.yaml",
        jsonPath: "channels.telegram.botToken",
        message: "Plaintext secret detected in field 'botToken'",
      },
    ]);

    const findings: DoctorFinding[] = await secretsAuditHealthCheck.run(baseContext);

    expect(findings.length).toBeGreaterThanOrEqual(1);
    const failFinding = findings.find((f) => f.status === "fail");
    expect(failFinding).toBeDefined();
    expect(failFinding?.category).toBe("secrets-audit");
  });

  it("returns warn DoctorFinding when auditSecrets returns warn-severity finding", async () => {
    vi.mocked(core.auditSecrets).mockReturnValue([
      {
        code: "KNOWN_PROVIDER_ENV",
        severity: "warn",
        file: "/tmp/test-comis/.env",
        jsonPath: "TELEGRAM_BOT_TOKEN",
        message: "Known telegram secret 'TELEGRAM_BOT_TOKEN' found in .env file",
      },
    ]);

    const findings: DoctorFinding[] = await secretsAuditHealthCheck.run(baseContext);

    expect(findings.length).toBeGreaterThanOrEqual(1);
    const warnFinding = findings.find((f) => f.status === "warn");
    expect(warnFinding).toBeDefined();
    expect(warnFinding?.category).toBe("secrets-audit");
  });

  it("returns pass DoctorFinding when auditSecrets returns empty array", async () => {
    vi.mocked(core.auditSecrets).mockReturnValue([]);

    const findings: DoctorFinding[] = await secretsAuditHealthCheck.run(baseContext);

    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.status).toBe("pass");
    expect(findings[0]?.category).toBe("secrets-audit");
  });

  it("returns skip DoctorFinding when auditSecrets throws an error", async () => {
    vi.mocked(core.auditSecrets).mockImplementation(() => {
      throw new Error("Authorization: Bearer PRIVATE_AUDIT_SENTINEL");
    });

    const findings: DoctorFinding[] = await secretsAuditHealthCheck.run(baseContext);

    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.status).toBe("skip");
    expect(findings[0]?.category).toBe("secrets-audit");
    expect(findings[0]?.message).not.toContain("PRIVATE_AUDIT_SENTINEL");
  });

  it("secretsAuditHealthCheck has correct id and name fields", () => {
    expect(secretsAuditHealthCheck.id).toBe("secrets-audit");
    expect(secretsAuditHealthCheck.name).toBe("Secrets Audit");
  });

  it("fail finding includes a suggestion to move value to SecretRef or environment variable", async () => {
    vi.mocked(core.auditSecrets).mockReturnValue([
      {
        code: "PLAINTEXT_SECRET",
        severity: "error",
        file: "/tmp/test-comis/config.yaml",
        jsonPath: "providers.openai.apiKey",
        message: "Plaintext secret detected in field 'apiKey'",
      },
    ]);

    const findings: DoctorFinding[] = await secretsAuditHealthCheck.run(baseContext);

    const failFinding = findings.find((f) => f.status === "fail");
    expect(failFinding?.suggestion).toContain("SecretRef");
  });
});
