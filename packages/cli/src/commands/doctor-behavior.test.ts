// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor command behavior tests.
 *
 * Tests doctor command behaviors: runs all 5 health check categories,
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

// Mock all three repair modules
vi.mock("../doctor/repairs/repair-config.js", () => ({
  repairConfig: vi.fn(),
}));
vi.mock("../doctor/repairs/repair-daemon.js", () => ({
  repairDaemon: vi.fn(),
}));
vi.mock("../doctor/repairs/repair-workspace.js", () => ({
  repairWorkspace: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock @comis/core for loadConfigFile/validateConfig
vi.mock("@comis/core", () => ({
  loadConfigFile: vi.fn(() => ({ ok: false })),
  validateConfig: vi.fn(() => ({ ok: false })),
  sanitizeLogString: vi.fn((s: string) => s),
}));

// Mock node:fs for readFileSync used in buildDoctorContext
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  existsSync: vi.fn(() => false),
}));

// Mock node:os for homedir
vi.mock("node:os", () => ({
  homedir: () => "/tmp/test-home",
}));

// Dynamic imports after mocks
const { registerDoctorCommand } = await import("./doctor.js");
const { runDoctorChecks } = await import("../doctor/check-runner.js");
const { renderDoctorTable, renderDoctorJson } = await import("../doctor/output.js");
const { repairConfig } = await import("../doctor/repairs/repair-config.js");
const { repairDaemon } = await import("../doctor/repairs/repair-daemon.js");
const { repairWorkspace } = await import("../doctor/repairs/repair-workspace.js");

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

describe("doctor runs all 5 health check categories", () => {
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

    const program = createTestProgram();
    registerDoctorCommand(program);

    await program.parseAsync(["node", "test", "doctor", "--repair"]);

    // runDoctorChecks called twice (initial + re-run after repair)
    expect(vi.mocked(runDoctorChecks)).toHaveBeenCalledTimes(2);

    // All three repair modules called
    expect(vi.mocked(repairConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairDaemon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairWorkspace)).toHaveBeenCalledTimes(1);

    // Output contains REPAIRED messages
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("REPAIRED:");
    expect(output).toContain("Created default config");
    expect(output).toContain("Removed stale PID");

    // Post-repair result is healthy, so no exit(1)
    expect(exitSpy.spy).not.toHaveBeenCalled();
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

    vi.mocked(repairConfig).mockResolvedValue({ ok: false, error: new Error("Permission denied") } as never);
    vi.mocked(repairDaemon).mockResolvedValue({ ok: true, value: [] } as never);
    vi.mocked(repairWorkspace).mockResolvedValue({ ok: true, value: [] } as never);

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
    expect(errOutput).toContain("Permission denied");

    // Exits 1 because post-repair result still has failures
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
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
