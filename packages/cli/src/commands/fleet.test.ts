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
  // QT2/QT3 — the fleet degradation detector. Required on FleetHealthReportSchema
  // (the real callTyped parses the response), so every fixture must carry it.
  // Intentionally NOT pre-sorted (output_starved < context_exhausted by count) so
  // the render test proves the renderer sorts count-desc, not insertion-order.
  degradedByCause: { output_starved: 9, context_exhausted: 13 },
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

describe("comis fleet table view does not render a misleading '$X · 0 tok' line when A3 degrades (WR-03)", () => {
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

  it("omits the contradictory '· 0 tok' when costUsd is non-zero but the A3 token read degraded", async () => {
    // WR-03: cost.costUsd is A1-sourced (session-summary store), cost.totalTokens
    // is A3-sourced (session-index files). When A3 degrades (daysMissing > 0) but
    // A1 survives, the report carries a real costUsd alongside totalTokens: 0 —
    // the prior render printed "$4.2 · 0 tok", which reads as a data bug. The
    // coverage block is the honest signal. After the fix the render must NOT emit
    // the "· 0 tok" contradiction and must surface the degraded-coverage note.
    const degradedReport = {
      ...FAKE_REPORT,
      cost: { costUsd: 4.2, totalTokens: 0 },
      activity: { ...FAKE_REPORT.activity, tokenTotal: 0 },
      coverage: {
        sessionSummary: { found: true, rows: 9 },
        sessionIndex: { daysRead: 0, daysMissing: 2 },
        billing: { present: true },
      },
    };
    const client: RpcClient = {
      call: () => Promise.resolve(degradedReport),
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync(["node", "test", "fleet"]);

    const output = getSpyOutput(consoleSpy.log);
    // The surviving A1 cost is still shown.
    expect(output).toContain("$4.2");
    // The misleading "0 tok" contradiction must NOT be rendered.
    expect(output).not.toContain("0 tok");
    // The honest degraded-coverage signal is surfaced instead.
    expect(output.toLowerCase()).toContain("tokens unavailable");
  });

  it("still renders the normal '$X · N tok' line when the A3 token read is healthy", async () => {
    // Coverage clean (or absent) + a real token total → the normal combined line.
    const client: RpcClient = {
      call: () => Promise.resolve(FAKE_REPORT), // totalTokens 735800, no coverage
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync(["node", "test", "fleet"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("735800 tok");
    expect(output.toLowerCase()).not.toContain("tokens unavailable");
  });
});

describe("comis fleet table view renders the degraded-by-cause breakdown (QT2/QT3) and omits it when empty", () => {
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

  it("renders 'Degraded by cause:' sorted count-desc (then name-asc) when degradedByCause is non-empty", async () => {
    // FAKE_REPORT.degradedByCause is { output_starved: 9, context_exhausted: 13 }
    // — insertion order puts output_starved first, but the render must sort by
    // count DESC so context_exhausted (13) leads. Pre-fix the renderer emitted no
    // degraded-by-cause line at all, so this FAILS on the pre-patch code (RED).
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerFleetCommand(program);
    await program.parseAsync(["node", "test", "fleet"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Degraded by cause:");
    // Count-desc ordering: context_exhausted (13) before output_starved (9).
    expect(output).toContain("Degraded by cause: context_exhausted=13, output_starved=9");
    // Closed-set labels + capped counts only — no raw bodies (bounded-payload).
    expect(output).not.toContain("undefined");
  });

  it("OMITS the 'Degraded by cause' line entirely when degradedByCause is {} (no spurious empty line)", async () => {
    // An all-clean window (or no named causes) → degradedByCause: {}. The render
    // must drop the line, not print "Degraded by cause: " with an empty list.
    const cleanReport = { ...FAKE_REPORT, degradedByCause: {} };
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
    // Sanity: the table still rendered (so the omission is the cause, not a crash).
    expect(output).toContain("Sessions");
    expect(output).not.toContain("Degraded by cause");
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
