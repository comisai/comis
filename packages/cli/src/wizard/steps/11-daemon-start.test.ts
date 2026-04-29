// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for daemon auto-start step (step 11).
 *
 * Verifies daemon spawn, health check polling, user decline flow,
 * daemon binary not found handling, and health check skip.
 * All external modules (child_process, node:fs, node:os, @comis/core,
 * global.fetch) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      pid: 12345,
    })),
  };
});

vi.mock("node:fs", () => ({
  // Default to true for daemon binary / pid file checks, but report
  // /.dockerenv as absent so the wizard takes the host (non-Docker)
  // branch. Docker-branch tests opt in by overriding existsSync.
  existsSync: vi.fn((p: string) => p !== "/.dockerenv"),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
  accessSync: vi.fn(),
  // 260428-qrn: `findContainerDaemonPid` walks /proc via dynamic
  // `await import("node:fs")`. Default to an empty proc so most tests
  // skip the SIGTERM branch; the dedicated Docker-restart test overrides.
  readdirSync: vi.fn(() => [] as unknown as string[]),
  readFileSync: vi.fn(() => "" as string),
  constants: { X_OK: 1, W_OK: 2 },
}));

vi.mock("node:os", () => {
  const homedir = vi.fn(() => "/home/test");
  return {
    homedir,
    default: { homedir },
  };
});

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: vi.fn((...parts: string[]) => parts.join("/")),
  };
});

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { daemonStartStep } from "./11-daemon-start.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    select?: string[];
  } = {},
): WizardPrompter {
  const selectQueue = [...(responses.select ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => opts.defaultValue ?? ""),
    select: vi.fn(async () => selectQueue.shift() ?? ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        result[key] = await (fn as () => Promise<unknown>)();
      }
      return result;
    }) as WizardPrompter["group"],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

function stateWithGateway(): WizardState {
  return {
    completedSteps: [],
    gateway: {
      port: 4766,
      bindMode: "loopback",
      authMethod: "token",
      token: "test-token-value",
    },
    provider: { id: "anthropic" },
  };
}

// ---------- Tests ----------

describe("daemonStartStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: every path exists EXCEPT /.dockerenv, so isDocker() is false
    // for the host (non-Docker) branch. Docker-branch tests can override.
    vi.mocked(existsSync).mockImplementation((p) => String(p) !== "/.dockerenv");

    // Mock global.fetch for health check
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "healthy" }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct step id and label", () => {
    expect(daemonStartStep.id).toBe("daemon-start");
    expect(daemonStartStep.label).toBe("Start Daemon");
  });

  it("user declines daemon start -> no spawn, step returns", async () => {
    const prompter = createMockPrompter({
      select: ["no"],
    });

    const result = await daemonStartStep.execute(stateWithGateway(), prompter);

    expect(spawn).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("comis daemon start"),
    );
  });

  it("user accepts daemon start -> spawn called, health check runs", async () => {
    const prompter = createMockPrompter({
      select: ["yes"],
    });

    await daemonStartStep.execute(stateWithGateway(), prompter);

    expect(spawn).toHaveBeenCalledWith(
      "node",
      expect.arrayContaining([expect.stringContaining("daemon")]),
      expect.objectContaining({ detached: true }),
    );

    // Spinner lifecycle
    const spinner = prompter.spinner();
    expect(spinner.start).toHaveBeenCalled();
    expect(spinner.stop).toHaveBeenCalled();
  });

  it("health check success -> spinner stops with ready message", async () => {
    const prompter = createMockPrompter({
      select: ["yes"],
    });

    await daemonStartStep.execute(stateWithGateway(), prompter);

    const spinner = prompter.spinner();
    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining("ready"),
    );
  });

  it("health check fails -> warning shown with log guidance", async () => {
    // Make fetch fail consistently (simulate health endpoint not responding)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const prompter = createMockPrompter({
      select: ["yes"],
    });

    // Set skipHealth to skip the runHealthCheck phase, but the waitForReady
    // polling will still run and fail, showing the non-ready message.
    // Increased timeout because waitForReady polls for up to 15s.
    await daemonStartStep.execute(
      { ...stateWithGateway(), skipHealth: true },
      prompter,
    );

    const spinner = prompter.spinner();
    // When health check times out, spinner should stop with a non-ready message
    expect(spinner.stop).toHaveBeenCalledWith(
      expect.stringContaining("not yet responding"),
    );
  }, 20_000);

  it("skipHealth=true in state -> health check skipped after spawn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "healthy" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const prompter = createMockPrompter({
      select: ["yes"],
    });

    const state: WizardState = {
      ...stateWithGateway(),
      skipHealth: true,
    };

    await daemonStartStep.execute(state, prompter);

    // Spawn should be called
    expect(spawn).toHaveBeenCalled();

    // fetch is called for waitForReady polling, but runHealthCheck should be skipped.
    // The health check function makes additional fetch calls beyond the readiness poll.
    // We verify by checking that the detailed health results are NOT logged.
    const infoCalls = vi.mocked(prompter.log.info).mock.calls;
    const healthResultCalls = infoCalls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("Health check results"),
    );
    expect(healthResultCalls).toHaveLength(0);
  });

  it("inside Docker (/.dockerenv present) -> does NOT spawn a sibling daemon", async () => {
    // Pretend we're in a container — /.dockerenv exists, plus the usual paths.
    vi.mocked(existsSync).mockReturnValue(true);

    // Daemon detection: gateway responds, so the wizard sees daemonRunning=true
    // and offers Restart/Leave-running. Choose Restart.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "healthy" }),
    }));

    const prompter = createMockPrompter({
      select: ["restart"],
    });

    await daemonStartStep.execute(stateWithGateway(), prompter);

    // Critical: the buggy direct-spawn path must NOT run inside Docker.
    expect(spawn).not.toHaveBeenCalled();

    // The Docker branch can't actually find the daemon process in this
    // unit-test sandbox (no /proc mock), so it should fall back to
    // instructing the user to run `docker restart`.
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls;
    const warnedAboutDockerRestart = warnCalls.some(
      ([msg]) => typeof msg === "string" && msg.includes("docker"),
    );
    expect(warnedAboutDockerRestart).toBe(true);
  });

  // 260428-qrn: when the wizard is about to SIGTERM the in-container daemon,
  // it must first emit a WARN naming `--restart unless-stopped` so the user
  // gets a breadcrumb before the daemon disappears. Asserted via invocation
  // call order: warn() must run BEFORE process.kill().
  it("inside Docker -> emits pre-SIGTERM WARN naming `unless-stopped` BEFORE process.kill", async () => {
    // /.dockerenv present + every other path exists (including the
    // /proc/<pid>/cmdline + status reads inside findContainerDaemonPid).
    vi.mocked(existsSync).mockReturnValue(true);
    // Stub /proc walk: one pid 42 owned by PID 1, cmdline contains "daemon.js".
    vi.mocked(readdirSync).mockReturnValue(["1", "42"] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockImplementation(((p: unknown) => {
      const path = String(p);
      if (path === "/proc/42/cmdline") return "node\0/app/packages/daemon/dist/daemon.js\0";
      if (path === "/proc/42/status") return "Name:\tnode\nPPid:\t1\n";
      return "";
    }) as never);

    // Gateway responds OK -> daemonRunning=true -> "Restart" branch.
    // After SIGTERM, the waitForRestart probe should report down-then-up so
    // the wizard reports success (not the fall-through warning). We do that
    // by failing the first few fetches then succeeding.
    let fetchCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      fetchCount++;
      if (fetchCount <= 1) {
        // initial daemonRunning probe
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
      }
      if (fetchCount <= 3) {
        // post-kill: gateway down phase
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      // gateway back up
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
    }));

    // Capture process.kill ordering without actually signalling the test runner.
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);

    const prompter = createMockPrompter({ select: ["restart"] });
    const warnSpy = prompter.log.warn as ReturnType<typeof vi.fn>;

    await daemonStartStep.execute(stateWithGateway(), prompter);

    // process.kill must have been invoked with SIGTERM on our fake PID 42.
    expect(killSpy).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);

    // The pre-SIGTERM WARN must mention both `unless-stopped` AND `docker restart`.
    const unlessStoppedCall = warnSpy.mock.calls.findIndex(
      ([msg]) => typeof msg === "string"
        && msg.includes("unless-stopped")
        && msg.includes("docker restart"),
    );
    expect(unlessStoppedCall).toBeGreaterThanOrEqual(0);

    // Order assertion: the WARN must fire BEFORE process.kill.
    const warnOrder = warnSpy.mock.invocationCallOrder[unlessStoppedCall]!;
    const killOrder = killSpy.mock.invocationCallOrder[0]!;
    expect(warnOrder).toBeLessThan(killOrder);

    // Buggy direct-spawn must still not run.
    expect(spawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("daemon binary not found -> warns user, no spawn", async () => {
    // existsSync returns false for daemon path check
    vi.mocked(existsSync).mockReturnValue(false);

    const prompter = createMockPrompter({
      select: ["yes"],
    });

    await daemonStartStep.execute(stateWithGateway(), prompter);

    // Spawn should NOT be called
    expect(spawn).not.toHaveBeenCalled();

    // Should warn about building first
    expect(prompter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("pnpm build"),
    );
  });

  it("returns state from execute", async () => {
    const prompter = createMockPrompter({
      select: ["no"],
    });

    const state = stateWithGateway();
    const result = await daemonStartStep.execute(state, prompter);

    expect(result.gateway).toBeDefined();
    expect(result.gateway!.port).toBe(4766);
  });

  it("shows section separator note", async () => {
    const prompter = createMockPrompter({
      select: ["no"],
    });

    await daemonStartStep.execute(stateWithGateway(), prompter);

    expect(prompter.note).toHaveBeenCalled();
  });
});
