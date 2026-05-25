// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis mcp` connection-management subcommands
 * (list / status / test / connect / disconnect / reconnect).
 *
 * The registration-shape and `ensureGatewayToken` token-resolution paths are
 * covered by `mcp.test.ts`; this file drives the ACTION handlers so the
 * success/JSON/error/validation branches inside `mcp.ts` are exercised:
 *
 *   - list: --format json (incl. empty list), the empty-list table friendly
 *     line, a populated table, and the RPC-error catch (exit 1).
 *   - status: --format json, the populated detail render (tools + capabilities
 *     + serverInfo + error), the minimal render (no tools/caps/info), and the
 *     RPC-error catch.
 *   - test: pre-RPC transport validation (stdio→--command, sse/http→--url, each
 *     exit 2), success render, probe-failed render (exit 1), and --format json.
 *   - connect: pre-RPC transport validation (exit 2), success render with the
 *     optional warning branch, and --format json.
 *   - disconnect: success render with the optional warning branch, --format json.
 *   - reconnect: success render, --format json.
 *
 * Harness mirrors `mcp-oauth.test.ts`: `withClient` + `callTyped` are mocked
 * (importOriginal keeps `ensureGatewayToken` real) so no socket opens, and
 * `withSpinner` runs its thunk synchronously so the action body executes
 * inside `parseAsync`. A live `COMIS_GATEWAY_TOKEN` is set so the token guard
 * passes and the handler reaches the RPC layer.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Module-level mocks (ESM hoisting — declared before the SUT import).
// ---------------------------------------------------------------------------

// importOriginal so ensureGatewayToken et al. stay real while withClient +
// callTyped are scripted per-test.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
    callTyped: vi.fn(),
  };
});

// withSpinner must run its thunk synchronously so the action body executes
// inside parseAsync.
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// ---------------------------------------------------------------------------
// SUT + mocked-module references (dynamic import AFTER mocks).
// ---------------------------------------------------------------------------

const { registerMcpCommand } = await import("./mcp.js");
const { withClient, callTyped } = await import("../client/rpc-client.js");

/** Build a fresh program with the full mcp command group wired. */
function buildProgram(): Command {
  const program = new Command();
  registerMcpCommand(program);
  return program;
}

/** Make withClient invoke its callback with a sentinel client. */
function wireWithClient(): void {
  vi.mocked(withClient).mockImplementation(async (fn) => fn({} as never));
}

describe("mcp connection-management subcommands — action behavior", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(callTyped).mockReset();
    process.env["COMIS_GATEWAY_TOKEN"] = "test-token";
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    wireWithClient();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    delete process.env["COMIS_GATEWAY_TOKEN"];
  });

  // ---- list -------------------------------------------------------------

  it("list --format json emits the raw result (incl. empty list)", async () => {
    vi.mocked(callTyped).mockResolvedValue({ servers: [], total: 0 } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "list", "--format", "json"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    // JSON path must serialize even the empty-list case (no friendly line).
    expect(out).toContain('"total": 0');
    expect(out).not.toMatch(/No MCP servers configured/);
  });

  it("list (table) with an empty list prints the friendly no-servers line", async () => {
    vi.mocked(callTyped).mockResolvedValue({ servers: [], total: 0 } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/No MCP servers configured/);
  });

  it("list (table) with servers renders a table including status + last-check", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      servers: [
        {
          name: "notion",
          status: "connected",
          toolCount: 3,
          lastHealthCheck: 1_700_000_000_000,
          reconnectAttempt: 0,
        },
        {
          name: "linear",
          status: "error",
          toolCount: 0,
          lastHealthCheck: 0, // never checked → "—"
          reconnectAttempt: 2,
        },
      ],
      total: 2,
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "list"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("notion");
    expect(out).toContain("linear");
    // The 0-timestamp row renders the "never checked" placeholder.
    expect(out).toContain("—");
  });

  it("list surfaces an RPC failure via error() + exit 1", async () => {
    vi.mocked(callTyped).mockRejectedValue(new Error("boom-list"));

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "list"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const err = getSpyOutput(consoleSpy.error);
    expect(err).toContain("boom-list");
  });

  // ---- status -----------------------------------------------------------

  it("status --format json emits the raw result", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      name: "notion",
      status: "connected",
      toolCount: 1,
      tools: [],
    } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "status",
      "notion",
      "--format",
      "json",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain('"name": "notion"');
  });

  it("status (table) renders tools, capabilities, serverInfo, and the error warning", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      name: "notion",
      status: "error",
      toolCount: 1,
      tools: [{ name: "search", description: "search pages" }],
      capabilities: { tools: {} },
      serverInfo: { name: "notion-mcp", version: "1.2.3" },
      error: "handshake failed",
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "status", "notion"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("search");
    expect(out).toContain("search pages");
    expect(out).toContain("notion-mcp v1.2.3");
    // The error is surfaced as a warning (console.error in format.warn? — it is
    // a stdout warn). Assert it appears across either stream.
    const all = `${out}\n${getSpyOutput(consoleSpy.error)}`;
    expect(all).toContain("handshake failed");
  });

  it("status (table) renders the minimal shape (no tools/caps/info/error → em dashes)", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      name: "empty",
      status: "disconnected",
      toolCount: 0,
      tools: [],
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "status", "empty"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("empty");
    // No capabilities / serverInfo → placeholder dash on both lines.
    expect(out).toContain("—");
  });

  it("status surfaces an RPC failure via error() + exit 1", async () => {
    vi.mocked(callTyped).mockRejectedValue(new Error("boom-status"));

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "status", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("boom-status");
  });

  // ---- test (probe) -----------------------------------------------------

  it("test stdio without --command fails validation with exit 2 (no RPC)", async () => {
    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "test",
        "srv",
        "--transport",
        "stdio",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
    expect(vi.mocked(callTyped)).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.error)).toContain("stdio transport requires --command");
  });

  it("test sse without --url fails validation with exit 2 (no RPC)", async () => {
    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "test",
        "srv",
        "--transport",
        "sse",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
    expect(vi.mocked(callTyped)).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.error)).toContain("sse transport requires --url");
  });

  it("test http without --url fails validation with exit 2 (no RPC)", async () => {
    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "test",
        "srv",
        "--transport",
        "http",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
    expect(getSpyOutput(consoleSpy.error)).toContain("http transport requires --url");
  });

  it("test success renders the reachable line + tool list", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      success: true,
      toolCount: 2,
      tools: ["a", "b"],
    } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "test",
      "srv",
      "--transport",
      "http",
      "--url",
      "https://srv.example/mcp",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/reachable/);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("test probe-failed renders error() + exit 1", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      success: false,
      error: "connection refused",
    } as never);

    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "test",
        "srv",
        "--transport",
        "stdio",
        "--command",
        "node",
        "--args",
        "server.js",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("connection refused");
  });

  it("test --format json emits the raw probe result", async () => {
    vi.mocked(callTyped).mockResolvedValue({ success: true, toolCount: 0, tools: [] } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "test",
      "srv",
      "--transport",
      "stdio",
      "--command",
      "node",
      "--format",
      "json",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain('"success": true');
  });

  // ---- connect ----------------------------------------------------------

  it("connect stdio without --command fails validation with exit 2 (no RPC)", async () => {
    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "connect",
        "srv",
        "--transport",
        "stdio",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
    expect(vi.mocked(callTyped)).not.toHaveBeenCalled();
  });

  it("connect sse without --url fails validation with exit 2 (no RPC)", async () => {
    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "connect",
        "srv",
        "--transport",
        "sse",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(2);
  });

  it("connect success renders the connected line, tools, AND the warning branch", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      status: "connected",
      toolCount: 1,
      tools: ["search"],
      persistence: "config.yaml",
      warning: "duplicate name collapsed",
    } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "connect",
      "notion",
      "--transport",
      "http",
      "--url",
      "https://notion.example/mcp",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("notion");
    expect(out).toContain("search");
    expect(out).toContain("config.yaml");
    const all = `${out}\n${getSpyOutput(consoleSpy.error)}`;
    expect(all).toContain("duplicate name collapsed");
  });

  it("connect --format json emits the raw result (no warning branch)", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      status: "connected",
      toolCount: 0,
      tools: [],
    } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "connect",
      "notion",
      "--transport",
      "stdio",
      "--command",
      "node",
      "--format",
      "json",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain('"status": "connected"');
  });

  it("connect surfaces an RPC failure via error() + exit 1", async () => {
    vi.mocked(callTyped).mockRejectedValue(new Error("boom-connect"));

    const program = buildProgram();
    try {
      await program.parseAsync([
        "node",
        "test",
        "mcp",
        "connect",
        "notion",
        "--transport",
        "stdio",
        "--command",
        "node",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("boom-connect");
  });

  // ---- disconnect -------------------------------------------------------

  it("disconnect success renders confirmation + the warning branch", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      persistence: "config.yaml",
      warning: "was already disconnected",
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "disconnect", "notion"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const all = `${getSpyOutput(consoleSpy.log)}\n${getSpyOutput(consoleSpy.error)}`;
    expect(all).toContain("notion");
    expect(all).toContain("was already disconnected");
  });

  it("disconnect --format json emits the raw result", async () => {
    vi.mocked(callTyped).mockResolvedValue({ persistence: "config.yaml" } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "disconnect",
      "notion",
      "--format",
      "json",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain('"persistence": "config.yaml"');
  });

  it("disconnect surfaces an RPC failure via error() + exit 1", async () => {
    vi.mocked(callTyped).mockRejectedValue(new Error("boom-disconnect"));

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "disconnect", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("boom-disconnect");
  });

  // ---- reconnect --------------------------------------------------------

  it("reconnect success renders the reconnected line + tools", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      status: "connected",
      toolCount: 2,
      tools: ["a", "b"],
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "reconnect", "notion"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("notion");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("reconnect --format json emits the raw result", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      status: "connected",
      toolCount: 0,
      tools: [],
    } as never);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "test",
      "mcp",
      "reconnect",
      "notion",
      "--format",
      "json",
    ]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    expect(getSpyOutput(consoleSpy.log)).toContain('"status": "connected"');
  });

  it("reconnect surfaces an RPC failure via error() + exit 1", async () => {
    vi.mocked(callTyped).mockRejectedValue(new Error("boom-reconnect"));

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "reconnect", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("boom-reconnect");
  });
});
