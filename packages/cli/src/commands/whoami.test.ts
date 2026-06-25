// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis whoami` CLI command (Phase 215-04, INTRO-01/02).
 *
 * `whoami` is the LIVE-only read of the run's resolved caps + remaining
 * budget/quota (the consumer of `capabilities.introspect`). Unlike `comis
 * explain` it has NO `--offline` fallback — remaining budget lives ONLY in the
 * running daemon's BoundedAutonomy maps, never on disk, so an unreachable daemon
 * must FAIL clearly rather than fabricate an empty/zero snapshot (Pitfall 4 / G5
 * / T-215-13).
 *
 * Mirrors explain.test.ts: `withClient` is mocked via importOriginal so the REAL
 * `callTyped` runs (it parses request `{}` and the response against
 * `CapabilitiesIntrospectContract`). The mock client returns a fake report;
 * console + process.exit are spied.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { CapabilitiesIntrospectContract } from "@comis/core";
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
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
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
const { registerWhoamiCommand } = await import("./whoami.js");
const { withClient } = await import("../client/rpc-client.js");

/**
 * A minimal-but-valid capabilities.introspect response — must satisfy the
 * contract's response schema (the real callTyped parses it). Carries a live
 * budget + outwardQuota.
 */
const FAKE_REPORT = {
  agentId: "agent-a",
  enabled: true,
  caps: ["orch:read", "orch:web"],
  budget: { tokensRemaining: 4000, wallClockMsRemaining: 120000, usdRemaining: 1.5 },
  outwardQuota: { perHourRemaining: 7 },
};

/** A caps-only response (no live root → no budget/quota). */
const CAPS_ONLY_REPORT = {
  agentId: "agent-a",
  enabled: true,
  caps: ["orch:read"],
};

/** Build a mock RpcClient whose `call` returns the given report. */
function clientReturning(report: unknown): RpcClient {
  return {
    call: () => Promise.resolve(report),
    close: () => {},
    onNotification: () => {},
  };
}

describe("comis whoami prints caps + remaining budget (table view)", () => {
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

  it("renders Agent, Caps, and a Budget line for the live report (table view)", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => fn(clientReturning(FAKE_REPORT)));

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "test", "whoami"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("agent-a");
    expect(output).toContain("orch:read");
    expect(output).toContain("orch:web");
    // The budget line surfaces the remaining tokens (and is NOT raw JSON).
    expect(output).toContain("Budget");
    expect(output).toContain("4000");
    expect(() => JSON.parse(output)).toThrow();
  });

  it("calls capabilities.introspect with an empty request body (self-scoped)", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: RpcClient = {
      call(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params });
        return Promise.resolve(FAKE_REPORT);
      },
      close: () => {},
      onNotification: () => {},
    };
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "test", "whoami"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(CapabilitiesIntrospectContract.method);
    // Self-scoped: the request is {} (the daemon injects _agentId).
    expect(calls[0]?.params).toEqual({});
  });
});

describe("comis whoami --format json emits the raw report", () => {
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

  it("prints JSON.stringify of the report when --format json is set", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => fn(clientReturning(FAKE_REPORT)));

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "test", "whoami", "--format", "json"]);

    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output) as { agentId?: string; caps?: string[] };
    expect(parsed.agentId).toBe("agent-a");
    expect(parsed.caps).toEqual(["orch:read", "orch:web"]);
  });
});

describe("comis whoami --caps prints caps only (omits the budget line)", () => {
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

  it("prints Caps but NOT the Budget line when --caps is set (even with a live budget)", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => fn(clientReturning(FAKE_REPORT)));

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "test", "whoami", "--caps"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("orch:read");
    // --caps omits the budget/quota lines even though the report carries them.
    expect(output).not.toContain("Budget");
    expect(output).not.toContain("Outward");
  });

  it("omits the budget line when the report carries no budget (no live root)", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => fn(clientReturning(CAPS_ONLY_REPORT)));

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "test", "whoami"]);

    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("orch:read");
    expect(output).not.toContain("Budget");
  });
});

describe("comis whoami is LIVE-only — an unreachable daemon fails clearly (no offline fabrication)", () => {
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

  it("prints an error and exits 1 when the daemon is unreachable — never a fabricated zero snapshot (T-215-13)", async () => {
    vi.mocked(withClient).mockRejectedValue(
      new Error("Cannot connect to daemon at ws://localhost:4766/ws."),
    );

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(program.parseAsync(["node", "test", "whoami"])).rejects.toThrow(
      "process.exit called",
    );

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("whoami failed");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    // The table branch must NOT have fabricated a snapshot.
    const stdout = getSpyOutput(consoleSpy.log);
    expect(stdout).not.toContain("Budget");
  });
});
