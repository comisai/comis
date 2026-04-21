// SPDX-License-Identifier: Apache-2.0
/**
 * Security command behavior tests.
 *
 * Tests security audit behaviors: runs all 14 checks with severity filtering,
 * JSON output, and correct exit codes; security fix defaults to dry-run with
 * --yes for apply mode including backup reporting.
 * Uses mocked check-runner, fix-runner, output, and spinner modules.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";
import type { AuditResult } from "../security/types.js";
import type { FixResult } from "../security/fix-types.js";

// Mock the check runner module
vi.mock("../security/check-runner.js", () => ({
  runSecurityAudit: vi.fn(),
}));

// Mock the fix runner module
vi.mock("../security/fix-runner.js", () => ({
  runSecurityFix: vi.fn(),
}));

// Mock the output module
vi.mock("../security/output.js", () => ({
  renderAuditTable: vi.fn(),
  renderAuditJson: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/core for loadConfigFile/validateConfig used in buildAuditContext
vi.mock("@comis/core", () => ({
  loadConfigFile: vi.fn(() => ({ ok: false })),
  validateConfig: vi.fn(() => ({ ok: false })),
  sanitizeLogString: vi.fn((s: string) => s),
}));

// Mock node:fs for readFileSync used in buildAuditContext
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
}));

// Mock node:os for homedir used in buildAuditContext
vi.mock("node:os", () => ({
  homedir: () => "/tmp/test-home",
}));

// Dynamic imports after mocks
const { registerSecurityCommand } = await import("./security.js");
const { runSecurityAudit } = await import("../security/check-runner.js");
const { runSecurityFix } = await import("../security/fix-runner.js");
const { renderAuditTable, renderAuditJson } = await import(
  "../security/output.js"
);

/** Mock AuditResult with mixed severity findings. */
function createMockAuditResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    findings: [
      {
        category: "file-permissions",
        severity: "critical",
        message: "Config world-readable",
        remediation: "chmod 600",
        code: "SEC-PERM-001",
      },
      {
        category: "gateway-exposure",
        severity: "critical",
        message: "Gateway exposed without TLS",
        remediation: "Enable TLS",
        code: "SEC-GW-001",
      },
      {
        category: "secrets-exposure",
        severity: "warning",
        message: "Possible secret in config",
        remediation: "Move to .env",
        code: "SEC-SECRET-SK_KEY",
      },
      {
        category: "config-validation",
        severity: "warning",
        message: "Config incomplete",
        remediation: "Add required fields",
        code: "SEC-CFG-001",
      },
      {
        category: "audit-logging",
        severity: "warning",
        message: "Audit logging not enabled",
        remediation: "Enable audit logging",
        code: "SEC-AUDIT-001",
      },
      {
        category: "browser-exposure",
        severity: "info",
        message: "Browser access advisory",
        remediation: "Review browser settings",
        code: "SEC-BROWSER-001",
      },
    ],
    checksRun: 14,
    criticalCount: 2,
    warningCount: 3,
    infoCount: 1,
    passed: false,
    ...overrides,
  };
}

describe("security audit runs all 14 checks and displays findings", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("invokes runSecurityAudit with all 14 checks and renders via renderAuditTable", async () => {
    const mockResult = createMockAuditResult();
    vi.mocked(runSecurityAudit).mockResolvedValue(mockResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    try {
      await program.parseAsync(["node", "test", "security", "audit"]);
    } catch (e) {
      // process.exit(1) throws because of critical findings
      expect((e as Error).message).toBe("process.exit called");
    }

    // runSecurityAudit should have been called once
    expect(runSecurityAudit).toHaveBeenCalledOnce();

    // renderAuditTable should have been called with the filtered result
    // (default severity is "info", so all findings pass through)
    expect(renderAuditTable).toHaveBeenCalledOnce();
    const renderedResult = vi.mocked(renderAuditTable).mock.calls[0][0] as AuditResult;
    expect(renderedResult.findings).toHaveLength(6);
    expect(renderedResult.checksRun).toBe(14);
  });
});

describe("security audit --severity warning filters findings", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("filters out info-level findings, keeping only critical and warning", async () => {
    const mockResult = createMockAuditResult();
    vi.mocked(runSecurityAudit).mockResolvedValue(mockResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    try {
      await program.parseAsync([
        "node",
        "test",
        "security",
        "audit",
        "--severity",
        "warning",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(renderAuditTable).toHaveBeenCalledOnce();
    const renderedResult = vi.mocked(renderAuditTable).mock.calls[0][0] as AuditResult;

    // Info findings should be excluded
    expect(renderedResult.infoCount).toBe(0);

    // Critical and warning findings should remain
    expect(renderedResult.criticalCount).toBe(2);
    expect(renderedResult.warningCount).toBe(3);
    expect(renderedResult.findings).toHaveLength(5);

    // Verify no info-severity finding is present
    const infoFindings = renderedResult.findings.filter(
      (f) => f.severity === "info",
    );
    expect(infoFindings).toHaveLength(0);
  });
});

describe("security audit --format json outputs JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls renderAuditJson instead of renderAuditTable", async () => {
    const mockResult = createMockAuditResult({
      findings: [],
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      passed: true,
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(mockResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "security",
      "audit",
      "--format",
      "json",
    ]);

    expect(renderAuditJson).toHaveBeenCalledOnce();
    expect(renderAuditTable).not.toHaveBeenCalled();
  });
});

describe("security audit exits 1 on critical findings", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls process.exit(1) when audit result has critical findings", async () => {
    const mockResult = createMockAuditResult({
      criticalCount: 1,
      passed: false,
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(mockResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    try {
      await program.parseAsync(["node", "test", "security", "audit"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  it("does not call process.exit when no critical findings", async () => {
    const mockResult = createMockAuditResult({
      findings: [
        {
          category: "test",
          severity: "warning",
          message: "Just a warning",
          remediation: "Review",
          code: "T-001",
        },
      ],
      criticalCount: 0,
      warningCount: 1,
      infoCount: 0,
      passed: true,
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(mockResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    await program.parseAsync(["node", "test", "security", "audit"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

describe("security fix dry-run by default", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(runSecurityFix).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("runs in dry-run mode showing DRY-RUN previews without applying", async () => {
    const mockAuditResult = createMockAuditResult();
    vi.mocked(runSecurityAudit).mockResolvedValue(mockAuditResult);

    const mockFixResult: FixResult = {
      applied: [],
      skipped: [
        {
          code: "SEC-PERM-001",
          description: "Fix perms",
          preview: () => "chmod 600 /tmp/test",
          apply: vi.fn(),
        },
      ],
      failed: [],
      backupPath: undefined,
    };
    vi.mocked(runSecurityFix).mockResolvedValue(mockFixResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    await program.parseAsync(["node", "test", "security", "fix"]);

    // runSecurityFix should have been called with apply: false
    expect(runSecurityFix).toHaveBeenCalledOnce();
    const fixArgs = vi.mocked(runSecurityFix).mock.calls[0];
    expect(fixArgs[2]).toEqual({ apply: false });

    // Output should contain DRY-RUN and the preview
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("DRY-RUN");
    expect(output).toContain("chmod 600");
    expect(output).toContain("Run with --yes to apply fixes");
  });
});

describe("security fix --yes applies fixes", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(runSecurityFix).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("applies fixes and reports FIXED/FAILED counts with backup path", async () => {
    const mockAuditResult = createMockAuditResult();
    vi.mocked(runSecurityAudit).mockResolvedValue(mockAuditResult);

    const mockAppliedAction = {
      code: "SEC-PERM-001",
      description: "Fixed perms",
      preview: () => "chmod 600 /tmp/test",
      apply: vi.fn(),
    };
    const mockFailedAction = {
      code: "SEC-CFG-001",
      description: "Fix config",
      preview: () => "fix config",
      apply: vi.fn(),
    };

    const mockFixResult: FixResult = {
      applied: [mockAppliedAction],
      skipped: [],
      failed: [{ action: mockFailedAction, error: new Error("Permission denied") }],
      backupPath: "/tmp/config.yaml.backup",
    };
    vi.mocked(runSecurityFix).mockResolvedValue(mockFixResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    try {
      await program.parseAsync(["node", "test", "security", "fix", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    // runSecurityFix should have been called with apply: true
    expect(runSecurityFix).toHaveBeenCalledOnce();
    const fixArgs = vi.mocked(runSecurityFix).mock.calls[0];
    expect(fixArgs[2]).toEqual({ apply: true });

    // Output should contain FIXED for applied actions
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("FIXED:");
    expect(output).toContain("SEC-PERM-001");

    // Output should contain FAILED for failed actions
    expect(output).toContain("FAILED:");
    expect(output).toContain("SEC-CFG-001");
    expect(output).toContain("Permission denied");

    // Output should contain backup path
    expect(output).toContain("/tmp/config.yaml.backup");

    // process.exit(1) because failed.length > 0
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

describe("security fix --yes creates config backup", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(runSecurityFix).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("reports backup path in output when config is backed up", async () => {
    const mockAuditResult = createMockAuditResult({
      findings: [],
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      passed: true,
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(mockAuditResult);

    const mockFixResult: FixResult = {
      applied: [
        {
          code: "SEC-PERM-001",
          description: "Fixed permissions",
          preview: () => "chmod 600 /tmp/config.yaml",
          apply: vi.fn(),
        },
      ],
      skipped: [],
      failed: [],
      backupPath: "/tmp/config.yaml.backup.20260214T120000Z",
    };
    vi.mocked(runSecurityFix).mockResolvedValue(mockFixResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    await program.parseAsync(["node", "test", "security", "fix", "--yes"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("backed up to");
    expect(output).toContain("/tmp/config.yaml.backup.20260214T120000Z");
  });
});

describe("security fix --format json outputs JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runSecurityAudit).mockReset();
    vi.mocked(runSecurityFix).mockReset();
    vi.mocked(renderAuditTable).mockReset();
    vi.mocked(renderAuditJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs structured JSON with applied/skipped/failed arrays", async () => {
    const mockAuditResult = createMockAuditResult({
      findings: [],
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      passed: true,
    });
    vi.mocked(runSecurityAudit).mockResolvedValue(mockAuditResult);

    const mockFixResult: FixResult = {
      applied: [
        {
          code: "SEC-PERM-001",
          description: "Fixed permissions",
          preview: () => "chmod 600 /tmp/config.yaml",
          apply: vi.fn(),
        },
      ],
      skipped: [
        {
          code: "SEC-PERM-003",
          description: "Fix data dir",
          preview: () => "chmod 700 /tmp/data",
          apply: vi.fn(),
        },
      ],
      failed: [
        {
          action: {
            code: "SEC-CFG-001",
            description: "Fix config",
            preview: () => "fix config",
            apply: vi.fn(),
          },
          error: new Error("Access denied"),
        },
      ],
      backupPath: "/tmp/backup.yaml",
    };
    vi.mocked(runSecurityFix).mockResolvedValue(mockFixResult);

    const program = createTestProgram();
    registerSecurityCommand(program);

    await program.parseAsync([
      "node",
      "test",
      "security",
      "fix",
      "--format",
      "json",
    ]);

    const output = getSpyOutput(consoleSpy.log);

    // The json() call outputs via console.log, so we need to find the JSON line
    // info() also uses console.log, so we need to parse the JSON from the output
    // The json() helper uses JSON.stringify(data, null, 2) which produces multiline JSON
    // Find the JSON block in the output
    const jsonStart = output.indexOf("{\n");
    const jsonContent = output.slice(jsonStart);
    const parsed = JSON.parse(jsonContent) as {
      applied: Array<{ code: string; description: string }>;
      skipped: Array<{ code: string; description: string; preview: string }>;
      failed: Array<{ code: string; description: string; error: string }>;
      backupPath: string;
    };

    expect(parsed.applied).toHaveLength(1);
    expect(parsed.applied[0].code).toBe("SEC-PERM-001");
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].code).toBe("SEC-PERM-003");
    expect(parsed.skipped[0].preview).toBe("chmod 700 /tmp/data");
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].code).toBe("SEC-CFG-001");
    expect(parsed.failed[0].error).toBe("Access denied");
    expect(parsed.backupPath).toBe("/tmp/backup.yaml");
  });
});
