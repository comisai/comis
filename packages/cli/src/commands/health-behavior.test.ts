// SPDX-License-Identifier: Apache-2.0
/**
 * Health command behavior tests.
 *
 * Tests health command behaviors: shows only fail/warn findings by default,
 * --all includes passes, --format json outputs valid filtered JSON, exits
 * code 1 when failures exist, exits normally for warnings-only, shows
 * "All checks passed" when no issues, and displays issue counts.
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

// Mock the check runner to return controlled results
vi.mock("../doctor/check-runner.js", () => ({
  runDoctorChecks: vi.fn(),
}));

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock all individual doctor checks (health.ts imports them)
vi.mock("../doctor/checks/config-health.js", () => ({
  configHealthCheck: { id: "config", name: "Config", run: vi.fn() },
}));
vi.mock("../doctor/checks/daemon-health.js", () => ({
  daemonHealthCheck: { id: "daemon", name: "Daemon", run: vi.fn() },
}));
vi.mock("../doctor/checks/gateway-health.js", () => ({
  gatewayHealthCheck: { id: "gateway", name: "Gateway", run: vi.fn() },
}));
vi.mock("../doctor/checks/channel-health.js", () => ({
  channelHealthCheck: { id: "channel", name: "Channel", run: vi.fn() },
}));
vi.mock("../doctor/checks/workspace-health.js", () => ({
  workspaceHealthCheck: { id: "workspace", name: "Workspace", run: vi.fn() },
}));

// Mock @comis/core for buildHealthContext (loadConfigFile, validateConfig)
vi.mock("@comis/core", () => ({
  loadConfigFile: vi.fn(() => ({ ok: false, error: { code: "FILE_NOT_FOUND" } })),
  validateConfig: vi.fn(() => ({ ok: true, value: {} })),
  sanitizeLogString: vi.fn((s: string) => s),
}));

// Mock node:fs readFileSync for buildHealthContext
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("not found");
  }),
}));

// Mock node:os for homedir in buildHealthContext
vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => "/tmp/test-home") },
  homedir: vi.fn(() => "/tmp/test-home"),
}));

// Dynamic imports after mocks
const { registerHealthCommand } = await import("./health.js");
const { runDoctorChecks } = await import("../doctor/check-runner.js");

// ── Test data helpers ────────────────────────────────────────────────────

function makeDoctorResult(overrides: Partial<DoctorResult>): DoctorResult {
  return {
    findings: [],
    checksRun: 5,
    passCount: 0,
    failCount: 0,
    warnCount: 0,
    skipCount: 0,
    repairableCount: 0,
    ...overrides,
  };
}

/** Mixed findings with 2 passes, 1 fail, 1 warn. */
const MIXED_FINDINGS = makeDoctorResult({
  findings: [
    { category: "Config", check: "config-file", status: "pass", message: "Config file exists", repairable: false },
    { category: "Daemon", check: "daemon-running", status: "fail", message: "No daemon process found", suggestion: "Run: comis daemon start", repairable: false },
    { category: "Gateway", check: "gateway-response", status: "warn", message: "Gateway response slow (>500ms)", suggestion: "Check network", repairable: false },
    { category: "Channel", check: "channel-connected", status: "pass", message: "Discord connected", repairable: false },
  ],
  checksRun: 5,
  passCount: 2,
  failCount: 1,
  warnCount: 1,
});

// ── health shows only failures/warnings by default ───────────────────────

describe("health shows only failures/warnings by default", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(runDoctorChecks).mockResolvedValue(MIXED_FINDINGS);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows fail and warn findings but filters out passes", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health"]);
    } catch (e) {
      // process.exit(1) throws due to our mock
      expect((e as Error).message).toBe("process.exit called");
    }

    const output = getSpyOutput(consoleSpy.log);

    // Fail finding visible
    expect(output).toContain("No daemon process found");
    // Warn finding visible
    expect(output).toContain("Gateway response slow");
    // Pass findings NOT visible
    expect(output).not.toContain("Config file exists");
    expect(output).not.toContain("Discord connected");
  });

  it("shows category header and suggestion text for fail finding", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health"]);
    } catch {
      // process.exit(1) throws
    }

    const output = getSpyOutput(consoleSpy.log);

    // Category header for fail finding
    expect(output).toContain("Daemon");
    // Suggestion text
    expect(output).toContain("Run: comis daemon start");
  });
});

// ── health --all includes passing checks ─────────────────────────────────

describe("health --all includes passing checks", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(runDoctorChecks).mockResolvedValue(MIXED_FINDINGS);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("includes pass findings when --all is specified", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health", "--all"]);
    } catch {
      // process.exit(1) throws due to failCount > 0
    }

    const output = getSpyOutput(consoleSpy.log);

    // Pass findings now included
    expect(output).toContain("Config file exists");
    expect(output).toContain("Discord connected");
    // Fail and warn still shown
    expect(output).toContain("No daemon process found");
    expect(output).toContain("Gateway response slow");
  });
});

// ── health --format json outputs valid JSON ───────────────────────────────

describe("health --format json outputs valid JSON", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(runDoctorChecks).mockResolvedValue(MIXED_FINDINGS);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs filtered JSON array with only fail and warn findings", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health", "--format", "json"]);
    } catch {
      // process.exit(1) throws
    }

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ status: string }>;

    expect(Array.isArray(parsed)).toBe(true);
    // Only fail and warn (2 items), passes filtered out
    expect(parsed).toHaveLength(2);
    expect(parsed.some((f) => f.status === "fail")).toBe(true);
    expect(parsed.some((f) => f.status === "warn")).toBe(true);
    expect(parsed.some((f) => f.status === "pass")).toBe(false);
  });
});

// ── health --all --format json includes all ───────────────────────────────

describe("health --all --format json includes all", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(runDoctorChecks).mockResolvedValue(MIXED_FINDINGS);
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("outputs all findings in JSON when --all is specified", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health", "--all", "--format", "json"]);
    } catch {
      // process.exit(1) throws
    }

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as Array<{ status: string }>;

    expect(parsed).toHaveLength(4);
  });
});

// ── health exits code 1 when failures exist ───────────────────────────────

describe("health exits code 1 when failures exist", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(makeDoctorResult({
      findings: [
        { category: "Daemon", check: "daemon-running", status: "fail", message: "No daemon", repairable: false },
        { category: "Gateway", check: "gateway-tls", status: "fail", message: "TLS not configured", repairable: false },
      ],
      failCount: 2,
    }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls process.exit(1) when failCount > 0", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

// ── health exits normally when only warnings exist ────────────────────────

describe("health exits normally when only warnings exist", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(makeDoctorResult({
      findings: [
        { category: "Gateway", check: "gateway-speed", status: "warn", message: "Slow", repairable: false },
      ],
      warnCount: 1,
      failCount: 0,
    }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("does NOT call process.exit when only warnings exist", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    await program.parseAsync(["node", "test", "health"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// ── health all checks pass ────────────────────────────────────────────────

describe("health all checks pass", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(makeDoctorResult({
      findings: [
        { category: "Config", check: "config", status: "pass", message: "OK", repairable: false },
      ],
      passCount: 1,
      failCount: 0,
      warnCount: 0,
    }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("shows 'All checks passed' when no issues and process.exit is NOT called", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    // Without --all, passes are filtered out, so the rendered table is empty
    await program.parseAsync(["node", "test", "health"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("All checks passed");
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });
});

// ── health table shows issue counts ──────────────────────────────────────

describe("health table shows issue counts", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(runDoctorChecks).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    vi.mocked(runDoctorChecks).mockResolvedValue(makeDoctorResult({
      findings: [
        { category: "Daemon", check: "daemon-running", status: "fail", message: "No daemon", repairable: false },
        { category: "Gateway", check: "gateway-speed", status: "warn", message: "Slow response", repairable: false },
        { category: "Gateway", check: "gateway-tls", status: "warn", message: "No TLS", repairable: false },
      ],
      failCount: 1,
      warnCount: 2,
    }));
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("displays total issue count and breakdown by type", async () => {
    const program = createTestProgram();
    registerHealthCommand(program);

    try {
      await program.parseAsync(["node", "test", "health"]);
    } catch {
      // process.exit(1) throws
    }

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("3 issues found");
    expect(output).toContain("1 error");
    expect(output).toContain("2 warnings");
  });
});
