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
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
  accessSync: vi.fn(),
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
import { existsSync } from "node:fs";
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
    vi.mocked(existsSync).mockReturnValue(true);

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
