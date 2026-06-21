// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis security audit-log` CLI subcommand (AUDIT-05,
 * Phase 176 Plan 05).
 *
 * Covers: the filter-flag → `obs.audit.query` param threading, the table render,
 * the `--format json` branch, and registration on the `comis security` tree.
 *
 * Mirrors the `explain.test.ts`/`fleet.test.ts` seam: `withClient` is mocked via
 * importOriginal so the REAL `callTyped` runs (it parses BOTH request against
 * `ObsAuditQueryContract` and response against `AuditQueryResponseSchema`), while
 * `withSpinner` is a pass-through. The captured (method, params) pair drives the
 * routing assertions.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObsAuditQueryContract } from "@comis/core";
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
const { registerSecurityCommand } = await import("./security.js");
const { withClient } = await import("../client/rpc-client.js");

/** A valid AuditQueryResponse (must satisfy AuditQueryResponseSchema — callTyped parses it). */
const FAKE_RESPONSE = {
  rows: [
    {
      id: "a1",
      tenantId: "tenant-a",
      agentId: "agent-1",
      ts: 1_700_000_000_000,
      kind: "secret_access",
      classification: null,
      action: "secrets.get",
      actor: null,
      outcome: "success",
      severity: "info",
      traceId: null,
      refs: null,
    },
  ],
};

/**
 * A mock RpcClient whose `call` records the params threaded through callTyped and
 * returns the fake response. The recorded (method, params) pair drives routing
 * assertions.
 */
function captureClient(response: unknown = FAKE_RESPONSE): {
  client: RpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RpcClient = {
    call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve(response);
    },
    close(): void {},
    onNotification(): void {},
  };
  return { client, calls };
}

describe("comis security audit-log", () => {
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

  it("is registered as a subcommand on the `comis security` tree", () => {
    const program = createTestProgram();
    registerSecurityCommand(program);
    const security = program.commands.find((c) => c.name() === "security");
    expect(security).toBeDefined();
    const auditLog = security?.commands.find((c) => c.name() === "audit-log");
    expect(auditLog, "security audit-log subcommand must be registered").toBeDefined();
  });

  it("threads obs.audit.query with the parsed filter flags", async () => {
    const { client, calls } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSecurityCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "security",
      "audit-log",
      "--kind",
      "secret_access",
      "--agent",
      "agent-1",
      "--outcome",
      "success",
      "--since",
      "100",
      "--until",
      "200",
      "--limit",
      "10",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(ObsAuditQueryContract.method);
    expect(calls[0]?.params).toEqual({
      kind: "secret_access",
      agentId: "agent-1",
      outcome: "success",
      since: 100,
      until: 200,
      limit: 10,
    });
  });

  it("prints the rows in the table view by default", async () => {
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSecurityCommand(program);
    await program.parseAsync(["node", "test", "security", "audit-log"]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("secret_access");
    expect(out).toContain("agent-1");
    expect(out).toContain("secrets.get");
  });

  it("emits the raw response under --format json", async () => {
    const { client } = captureClient();
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSecurityCommand(program);
    await program.parseAsync(["node", "test", "security", "audit-log", "--format", "json"]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain('"rows"');
    expect(out).toContain('"secret_access"');
    // The JSON branch must not also print the table header.
    expect(out).not.toContain("audit event(s):");
  });

  it("prints an empty-result message when no rows match", async () => {
    const { client } = captureClient({ rows: [] });
    vi.mocked(withClient).mockImplementation(async (fn) => fn(client));

    const program = createTestProgram();
    registerSecurityCommand(program);
    await program.parseAsync(["node", "test", "security", "audit-log", "--kind", "nope"]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/no audit events/i);
  });
});
