// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis fleet` CLI command.
 *
 * Covers the typed RPC call (obs.fleet.health via callTyped over
 * ObsFleetHealthContract), --since <hours> threading, --format json vs the
 * default table render, the RPC-error → exit(1) path, and — critically — that
 * the registered command is named "fleet" (a DISTINCT remote-admin RPC), NOT
 * "health" (the LOCAL doctor command, which is left untouched).
 *
 * Mirrors the established `explain.test.ts` seam: `withClient` is mocked via
 * importOriginal so the REAL `callTyped` runs (it parses BOTH request and
 * response against `ObsFleetHealthContract`/`FleetHealthReportSchema`), while
 * `withSpinner` is a pass-through. Params threaded into `client.call` are
 * captured to assert the method string and the { sinceHours } request shape.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObsFleetHealthContract } from "@comis/core";
import type { RpcClient } from "../client/rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient at module level (ESM hoisting); importOriginal keeps the real
// callTyped so request/response Zod validation actually runs end-to-end.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock withSpinner to pass-through (no ora spinner in tests).
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Dynamic imports after mocks.
const { registerFleetCommand } = await import("./fleet.js");
const { withClient } = await import("../client/rpc-client.js");

/**
 * A minimal-but-valid FleetHealthReport — must satisfy FleetHealthReportSchema
 * because the real callTyped parses the response. `likelyRootCause` is non-null
 * and `findings`/`suggestedNextSteps` are non-empty so the table-view's
 * findings/root-cause/next-step branches are all exercised.
 */
const FAKE_REPORT = {
  schemaVersion: 1 as const,
  windowHours: 12,
  sessions: { total: 40, degraded: 22, degradedRate: 0.55 },
  topErrorKinds: [{ kind: "dependency", count: 18 }],
  breakerTripTotal: 3,
  toolStats: { web_fetch: { ok: 2, failed: 8 } },
  cost: { costUsd: 1.32, totalTokens: 735800 },
  activity: {
    activeAgents: ["default"],
    activeChannels: ["telegram"],
    exitReasons: { completed_with_tool_errors: 22 },
    turnTotal: 500,
    tokenTotal: 735800,
  },
  findings: [
    {
      code: "fleet_recurring_health_signal",
      detail: "lcd_divergence recurred across the window",
      count: 14,
      hint: "inspect the LCD compaction path",
    },
  ],
  likelyRootCause: {
    code: "fleet_high_degraded_rate",
    detail: "over half the window's sessions degraded",
    suggestedNextSteps: ["obs.explain the worst session"],
  },
  suggestedNextSteps: ["raise the breaker threshold"],
  truncations: [],
};

/**
 * Build a mock RpcClient whose `call` records the params threaded through
 * callTyped and returns the fake report. The recorded (method, params) pair
 * drives the method-string + { sinceHours } request assertions.
 */
function captureClient(): {
  client: RpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve(FAKE_REPORT);
    },
    close(): void {},
    onNotification(): void {},
  };
  return { client, calls };
}

describe("comis fleet --since N --format json threads obs.fleet.health { sinceHours: N }", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls obs.fleet.health with { sinceHours: 12 } and prints the JSON report", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "fleet",
      "--since",
      "12",
      "--format",
      "json",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(ObsFleetHealthContract.method);
    expect(calls[0]?.params).toEqual({ sinceHours: 12 });

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { windowHours?: number };
    expect(parsed.windowHours).toBe(12);
  });
});

describe("comis fleet (defaults) uses --since 24 --format table", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("defaults to sinceHours 24 and renders the key table fields (not raw JSON)", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync(["node", "test", "fleet"]);

    // Default window is 24h, applied client-side before the call.
    expect(calls[0]?.params).toEqual({ sinceHours: 24 });

    const output = getSpyOutput(consoleSpy.log);
    // The table branch renders the key fields via info(...).
    expect(output).toContain("Window");
    expect(output).toContain("Sessions");
    expect(output).toContain("Breaker");
    expect(output).toContain("Cost");
    // findings + root-cause + next-steps lines.
    expect(output).toContain("fleet_recurring_health_signal");
    expect(output).toContain("fleet_high_degraded_rate");
    expect(output).toContain("raise the breaker threshold");
    // The table branch must NOT have emitted the whole report as JSON.
    expect(() => JSON.parse(output)).toThrow();
  });
});

describe("comis fleet table view tolerates a null likelyRootCause and empty findings/next-steps", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("omits the root-cause line and renders no findings/next-steps when all are absent", async () => {
    const cleanReport = {
      ...FAKE_REPORT,
      findings: [],
      likelyRootCause: null,
      suggestedNextSteps: [],
    };
    const client: RpcClient = {
      call: () => Promise.resolve(cleanReport),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync(["node", "test", "fleet"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Window");
    expect(output).not.toContain("Root cause");
    expect(output).not.toContain("→");
  });
});

describe("comis fleet with an RPC error prints error and exits with code 1", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls error() and process.exit(1) when the obs.fleet.health call rejects", async () => {
    const client: RpcClient = {
      call: () => Promise.reject(new Error("Admin access required")),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);

    await expect(
      program.parseAsync(["node", "test", "fleet"]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("fleet failed");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

describe("registerFleetCommand registers a command named 'fleet', DISTINCT from 'health'", () => {
  it("adds a 'fleet' command (the remote admin RPC) — NOT 'health' (the local doctor)", () => {
    const program = createTestProgram();
    registerFleetCommand(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("fleet");
    // The new command must NOT overload the existing local-doctor `comis health`.
    expect(names).not.toContain("health");
  });
});
