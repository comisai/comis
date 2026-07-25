// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor command behavior tests.
 *
 * Tests doctor command behaviors across the complete diagnostic registry,
 * --repair invokes repair modules and re-runs diagnostics, --format json
 * calls renderDoctorJson, and exit code 1 on failures.
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
import type { DoctorResult } from "../doctor/types.js";

// Mock the doctor check runner
vi.mock("../doctor/check-runner.js", () => ({
  runDoctorChecks: vi.fn(),
}));

// Mock the doctor output module
vi.mock("../doctor/output.js", () => ({
  renderDoctorTable: vi.fn(),
  renderDoctorJson: vi.fn(),
}));

// Mock all four repair modules
vi.mock("../doctor/repairs/repair-config.js", () => ({
  repairConfig: vi.fn(),
}));
vi.mock("../doctor/repairs/repair-daemon.js", () => ({
  repairDaemon: vi.fn(),
}));
vi.mock("../doctor/repairs/repair-workspace.js", () => ({
  repairWorkspace: vi.fn(),
}));
vi.mock("../doctor/repairs/repair-config-audit.js", () => ({
  repairConfigAudit: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/core for loadConfigFile/validateConfig
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadConfigFile: vi.fn(() => ({ ok: false })),
    validateConfig: vi.fn(() => ({ ok: false })),
    sanitizeLogString: vi.fn((s: string) => s),
  };
});

// Mock node:fs for readFileSync used in buildDoctorContext
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  existsSync: vi.fn(() => false),
}));

const repairBoundaryMocks = vi.hoisted(() => ({
  database: vi.fn(),
  repairFtsDrift: vi.fn(),
  repairContextItems: vi.fn(),
}));

vi.mock("better-sqlite3", () => ({ default: repairBoundaryMocks.database }));
vi.mock("../doctor/repairs/repair-lcd.js", () => ({
  repairFtsDrift: repairBoundaryMocks.repairFtsDrift,
  repairContextItems: repairBoundaryMocks.repairContextItems,
}));

// Mock node:os for homedir
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => "/tmp/test-home",
  };
});

// Dynamic imports after mocks
const { registerDoctorCommand } = await import("./doctor.js");
const { runDoctorChecks } = await import("../doctor/check-runner.js");
const { renderDoctorTable, renderDoctorJson } = await import("../doctor/output.js");
const { repairConfig } = await import("../doctor/repairs/repair-config.js");
const { repairDaemon } = await import("../doctor/repairs/repair-daemon.js");
const { repairWorkspace } = await import("../doctor/repairs/repair-workspace.js");
const { repairConfigAudit } = await import("../doctor/repairs/repair-config-audit.js");
const fs = await import("node:fs");

/** Factory: a healthy doctor result with no failures. */
const healthyResult: DoctorResult = {
  findings: [
    { category: "config", check: "Config files", status: "pass", message: "Config valid", repairable: false },
    { category: "daemon", check: "Process alive", status: "pass", message: "Daemon running", repairable: false },
  ],
  checksRun: 5,
  passCount: 2,
  failCount: 0,
  warnCount: 0,
  skipCount: 0,
  repairableCount: 0,
};

/** Factory: a failing doctor result with repairable issues. */
const failingResult: DoctorResult = {
  findings: [
    { category: "config", check: "Config files", status: "fail", message: "Config missing", repairable: true, suggestion: "Run init" },
    { category: "daemon", check: "Process alive", status: "fail", message: "Stale PID", repairable: true },
    { category: "gateway", check: "Gateway reachable", status: "fail", message: "Not responding", repairable: false },
  ],
  checksRun: 5,
  passCount: 0,
  failCount: 3,
  warnCount: 0,
  skipCount: 0,
  repairableCount: 2,
};

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(fs.existsSync).mockReturnValue(false);
  repairBoundaryMocks.database.mockReset();
  repairBoundaryMocks.database.mockImplementation(function DatabaseMock() {
    return { pragma: vi.fn(), close: vi.fn() };
  });
  repairBoundaryMocks.repairFtsDrift.mockReset();
  repairBoundaryMocks.repairFtsDrift.mockResolvedValue({ ok: true, value: [] });
  repairBoundaryMocks.repairContextItems.mockReset();
  repairBoundaryMocks.repairContextItems.mockResolvedValue({ ok: true, value: [] });
});

describe("doctor runs the complete diagnostic registry", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    vi.mocked(renderDoctorJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(healthyResult);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("invokes runDoctorChecks once and renders via renderDoctorTable", async () => {
    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor"]);

    expect(vi.mocked(runDoctorChecks)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderDoctorTable)).toHaveBeenCalledWith(healthyResult);
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

describe("doctor --repair auto-fixes and re-runs", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    vi.mocked(renderDoctorJson).mockReset();
    vi.mocked(repairConfig).mockReset();
    vi.mocked(repairDaemon).mockReset();
    vi.mocked(repairWorkspace).mockReset();
    vi.mocked(repairConfigAudit).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("runs repairs then re-runs diagnostics when repairable issues found", async () => {
    // First call: failing with repairable issues. Second call: healthy (post-repair)
    vi.mocked(runDoctorChecks)
      .mockResolvedValueOnce(failingResult)
      .mockResolvedValueOnce(healthyResult);

    vi.mocked(repairConfig).mockResolvedValue({ ok: true, value: ["Created default config"] } as never);
    vi.mocked(repairDaemon).mockResolvedValue({ ok: true, value: ["Removed stale PID"] } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairConfigAudit).mockResolvedValue({
      ok: true,
      value: ["Config-audit scrub: log already clean (no changes)."],
    } as never);

    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor", "--repair"]);

    // runDoctorChecks called twice (initial + re-run after repair)
    expect(vi.mocked(runDoctorChecks)).toHaveBeenCalledTimes(2);

    // All four repair modules called.
    expect(vi.mocked(repairConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairWorkspace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairConfigAudit)).toHaveBeenCalledTimes(1);

    // Output contains REPAIRED messages
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("REPAIRED:");
    expect(output).toContain("Created default config");
    expect(output).toContain("Removed stale PID");
    expect(output).toContain("Config-audit scrub");

    // Post-repair result is healthy, so no exit(1)
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  it("does NOT call repairConfigAudit when --repair is omitted (opt-in semantics)", async () => {
    vi.mocked(runDoctorChecks).mockResolvedValueOnce(failingResult);

    const program = createTestProgram();
    registerDoctorCommand(program);

    // Without --repair (plain `comis doctor`), the repair modules
    // are never invoked. The scrubber is opt-in only.
    try {
      await program.parseAsync(["node", "test", "doctor"]);
    } catch {
      // process.exit(1) from the failing result is expected.
    }
    expect(vi.mocked(repairConfigAudit)).not.toHaveBeenCalled();
  });
});

describe("doctor --repair with repair failures", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    vi.mocked(renderDoctorJson).mockReset();
    vi.mocked(repairConfig).mockReset();
    vi.mocked(repairDaemon).mockReset();
    vi.mocked(repairWorkspace).mockReset();
    vi.mocked(repairConfigAudit).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("reports FAILED for repair errors and exits 1 if post-repair still failing", async () => {
    // Both calls return failing result (repairs didn't fix everything)
    vi.mocked(runDoctorChecks)
      .mockResolvedValueOnce(failingResult)
      .mockResolvedValueOnce(failingResult);

    vi.mocked(repairConfig).mockResolvedValue({
      ok: false,
      error: new Error("Authorization: Bearer PRIVATE_CONFIG_REPAIR_SENTINEL"),
    } as never);
    vi.mocked(repairDaemon).mockResolvedValue({
      ok: false,
      error: new Error("PRIVATE_DAEMON_REPAIR_SENTINEL"),
    } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({
      ok: false,
      error: new Error("PRIVATE_WORKSPACE_REPAIR_SENTINEL"),
    } as never);
    // Daemon-not-running is the typical failure mode for the audit
    // scrub in repair contexts; surface as Err.
    vi.mocked(repairConfigAudit).mockResolvedValue({
      ok: false,
      error: new Error("PRIVATE_AUDIT_REPAIR_SENTINEL"),
    } as never);

    const program = createTestProgram();
    registerDoctorCommand(program);

    try {
      await program.parseAsync(["node", "test", "doctor", "--repair"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    // Output contains FAILED message for config repair
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("FAILED:");
    const combinedOutput = `${errOutput}\n${getSpyOutput(consoleSpy.log)}`;
    expect(combinedOutput).not.toContain("PRIVATE_CONFIG_REPAIR_SENTINEL");
    expect(combinedOutput).not.toContain("PRIVATE_DAEMON_REPAIR_SENTINEL");
    expect(combinedOutput).not.toContain("PRIVATE_WORKSPACE_REPAIR_SENTINEL");
    expect(combinedOutput).not.toContain("PRIVATE_AUDIT_REPAIR_SENTINEL");

    // Exits 1 because post-repair result still has failures
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });

  it("does not surface database-open error content during LCD repair", async () => {
    const lcdFailure: DoctorResult = {
      ...failingResult,
      findings: [
        {
          category: "lcd",
          check: "FTS drift",
          status: "fail",
          message: "FTS drift detected",
          repairable: true,
        },
      ],
      repairableCount: 1,
    };
    vi.mocked(runDoctorChecks)
      .mockResolvedValueOnce(lcdFailure)
      .mockResolvedValueOnce(healthyResult);
    vi.mocked(repairConfig).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairDaemon).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairConfigAudit).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    repairBoundaryMocks.database.mockImplementation(function DatabaseFailure() {
      throw new Error("Authorization: Bearer PRIVATE_LCD_OPEN_SENTINEL");
    });

    const program = createTestProgram();
    registerDoctorCommand(program);
    await program.parseAsync(["node", "test", "doctor", "--repair"]);

    expect(getSpyOutput(consoleSpy.error)).not.toContain("PRIVATE_LCD_OPEN_SENTINEL");
  });

  it("opens the configured custom memory database for LCD repair", async () => {
    const lcdFailure: DoctorResult = {
      ...failingResult,
      findings: [
        {
          category: "lcd",
          check: "FTS drift",
          status: "fail",
          message: "FTS drift detected",
          repairable: true,
        },
      ],
      repairableCount: 1,
    };
    vi.mocked(runDoctorChecks)
      .mockResolvedValueOnce(lcdFailure)
      .mockResolvedValueOnce(healthyResult);
    vi.mocked(repairConfig).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairDaemon).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairConfigAudit).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(fs.readFileSync).mockReturnValue(
      "dataDir: /srv/comis\nmemory:\n  dbPath: stores/custom-memory.db\n",
    );
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const program = createTestProgram();
    registerDoctorCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "doctor",
      "--repair",
      "--config",
      "/cfg/custom.yaml",
    ]);

    expect(repairBoundaryMocks.database).toHaveBeenCalledWith(
      "/srv/comis/stores/custom-memory.db",
      { timeout: 5000 },
    );
    expect(repairBoundaryMocks.repairFtsDrift).toHaveBeenCalledTimes(1);
    expect(repairBoundaryMocks.repairContextItems).toHaveBeenCalledTimes(1);
  });

  it("does not surface LCD repair-operation error content", async () => {
    const lcdFailure: DoctorResult = {
      ...failingResult,
      findings: [
        {
          category: "lcd",
          check: "FTS drift",
          status: "fail",
          message: "FTS drift detected",
          repairable: true,
        },
      ],
      repairableCount: 1,
    };
    vi.mocked(runDoctorChecks)
      .mockResolvedValueOnce(lcdFailure)
      .mockResolvedValueOnce(healthyResult);
    vi.mocked(repairConfig).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairDaemon).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairConfigAudit).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    repairBoundaryMocks.repairFtsDrift.mockResolvedValue({
      ok: false,
      error: new Error("PRIVATE_LCD_FTS_SENTINEL"),
    });
    repairBoundaryMocks.repairContextItems.mockResolvedValue({
      ok: false,
      error: new Error("PRIVATE_LCD_CONTEXT_SENTINEL"),
    });

    const program = createTestProgram();
    registerDoctorCommand(program);
    await program.parseAsync(["node", "test", "doctor", "--repair"]);

    const output = getSpyOutput(consoleSpy.error);
    expect(output).not.toContain("PRIVATE_LCD_FTS_SENTINEL");
    expect(output).not.toContain("PRIVATE_LCD_CONTEXT_SENTINEL");
  });
});

describe("doctor --repair with no repairable issues", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    vi.mocked(renderDoctorJson).mockReset();
    vi.mocked(repairConfig).mockReset();
    vi.mocked(repairDaemon).mockReset();
    vi.mocked(repairWorkspace).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints info message and does not call repair modules", async () => {
    // Result with no repairable issues (and no failures)
    const noRepairResult: DoctorResult = {
      findings: [
        { category: "config", check: "Config files", status: "pass", message: "Config valid", repairable: false },
      ],
      checksRun: 5,
      passCount: 1,
      failCount: 0,
      warnCount: 0,
      skipCount: 0,
      repairableCount: 0,
    };

    vi.mocked(runDoctorChecks).mockResolvedValue(noRepairResult);

    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor", "--repair"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("No repairable issues found");

    // Repair modules should NOT have been called
    expect(vi.mocked(repairConfig)).not.toHaveBeenCalled();
    expect(vi.mocked(repairDaemon)).not.toHaveBeenCalled();
    expect(vi.mocked(repairWorkspace)).not.toHaveBeenCalled();
  });
});

describe("doctor --format json outputs JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    vi.mocked(renderDoctorJson).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(healthyResult);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls renderDoctorJson and NOT renderDoctorTable", async () => {
    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor", "--format", "json"]);

    expect(vi.mocked(renderDoctorJson)).toHaveBeenCalledWith(healthyResult);
    expect(vi.mocked(renderDoctorTable)).not.toHaveBeenCalled();
  });
});

describe("doctor exits 1 on failures", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls process.exit(1) when failCount > 0 and --repair not used", async () => {
    vi.mocked(runDoctorChecks).mockResolvedValue(failingResult);

    const program = createTestProgram();
    registerDoctorCommand(program);

    try {
      await program.parseAsync(["node", "test", "doctor"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

describe("doctor does not exit 1 when no failures", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    vi.mocked(renderDoctorTable).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(healthyResult);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("does not call process.exit when failCount is 0", async () => {
    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});
