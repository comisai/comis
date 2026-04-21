// SPDX-License-Identifier: Apache-2.0
/**
 * Edge case tests for CLI utility functions and rendering.
 *
 * Covers: formatRelativeTime boundary conditions,
 * RPC config resolver edge cases, SIGINT prompt
 * cancellation, and table rendering extremes.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime } from "./sessions.js";
import { renderTable, renderKeyValue } from "../output/table.js";
import { createConsoleSpy, getSpyOutput } from "../test-helpers.js";

// ─── formatRelativeTime boundary conditions ─────────────────────────────────

describe("formatRelativeTime boundary conditions", () => {
  it("returns '0s ago' for zero difference (exact now)", () => {
    const result = formatRelativeTime(Date.now());
    expect(result).toBe("0s ago");
  });

  it("returns 'just now' for future timestamps (1 second ahead)", () => {
    const result = formatRelativeTime(Date.now() + 1000);
    expect(result).toBe("just now");
  });

  it("returns 'just now' for far-future timestamps", () => {
    const result = formatRelativeTime(Date.now() + 86400000);
    expect(result).toBe("just now");
  });

  it("handles exactly 60 seconds (should show '1m ago' not '60s ago')", () => {
    const result = formatRelativeTime(Date.now() - 60_000);
    expect(result).toBe("1m ago");
  });

  it("handles exactly 1 hour boundary", () => {
    const result = formatRelativeTime(Date.now() - 3600_000);
    expect(result).toBe("1h ago");
  });

  it("handles exactly 1 day boundary", () => {
    const result = formatRelativeTime(Date.now() - 86400_000);
    expect(result).toBe("1d ago");
  });

  it("handles exactly 30 days boundary", () => {
    const result = formatRelativeTime(Date.now() - 30 * 86400_000);
    expect(result).toBe("1mo ago");
  });

  it("handles very large values (365 days ago)", () => {
    const result = formatRelativeTime(Date.now() - 365 * 86400_000);
    expect(result).toBe("12mo ago");
  });

  it("handles very large values (10 years ago)", () => {
    const result = formatRelativeTime(Date.now() - 10 * 365 * 86400_000);
    expect(result).toMatch(/^\d+mo ago$/);
    // Should not produce NaN or Infinity
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("Infinity");
  });

  it("handles timestamp of 0 (epoch start)", () => {
    const result = formatRelativeTime(0);
    expect(result).toMatch(/^\d+mo ago$/);
    expect(result).not.toContain("NaN");
  });

  it("handles negative timestamp", () => {
    expect(() => formatRelativeTime(-1000)).not.toThrow();
    const result = formatRelativeTime(-1000);
    expect(result).toMatch(/^\d+mo ago$/);
    expect(result).not.toContain("NaN");
  });
});

// ─── RPC config resolver edge cases ────────────────────────────────────────

/**
 * Mock WebSocket class that simulates ws behavior for config resolver tests.
 * Defined via vi.hoisted so it is available when vi.mock factory runs (hoisted).
 */
const { MockWebSocket } = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");

  class MockWebSocket extends EventEmitter {
    static instances: InstanceType<typeof MockWebSocket>[] = [];

    url: string;
    options: { headers?: Record<string, string> };
    sentMessages: string[] = [];
    terminated = false;
    closed = false;
    connected = false;

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      super();
      this.url = url;
      this.options = options ?? {};
      MockWebSocket.instances.push(this);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.closed = true;
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  return { MockWebSocket };
});

vi.mock("ws", () => ({ default: MockWebSocket }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  accessSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => "/fake/home") },
  homedir: vi.fn(() => "/fake/home"),
}));
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn((_msg: string, fn: () => unknown) => fn()),
}));

function getLastWs(): InstanceType<typeof MockWebSocket> {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

// Dynamic import after mock registration
const { withClient } = await import("../client/rpc-client.js");

/**
 * Schedule the mock WebSocket 'open' event to fire once the WebSocket is constructed.
 */
function connectLastWsAsync(): void {
  const interval = setInterval(() => {
    const ws = getLastWs();
    if (ws && !ws.connected) {
      ws.connected = true;
      ws.emit("open");
      clearInterval(interval);
    }
  }, 1);
}

describe("RPC config resolver edge cases", () => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    MockWebSocket.instances = [];
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
  });

  afterEach(() => {
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
  });

  it("handles config with no gateway section", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("logLevel: debug\ntenantId: test\n");

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://localhost:4766/ws");
  });

  it("handles config with empty gateway values", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("gateway:\n  host:\n  port:\n");

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://localhost:4766/ws");
  });

  it("handles config with comments in gateway section", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      [
        "gateway:",
        "  # This is a comment",
        "  host: real-host",
        "  port: 4200",
        "  # tokens:",
      ].join("\n"),
    );

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://real-host:4200/ws");
  });

  it("handles config with only comments", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("# just comments\n# nothing else\n");

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://localhost:4766/ws");
  });

  it("handles config with gateway section followed by another section", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      [
        "gateway:",
        "  host: gw-host",
        "  port: 5000",
        "routing:",
        "  agents:",
        "    test: {}",
      ].join("\n"),
    );

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://gw-host:5000/ws");
  });

  it("handles config with tabs instead of spaces", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      "gateway:\n\thost: tab-host\n\tport: 6000\n",
    );

    connectLastWsAsync();
    await withClient(async () => "done");

    const ws = getLastWs();
    expect(ws.url).toBe("ws://tab-host:6000/ws");
  });
});

// ─── Table rendering with extreme data ─────────────────────────────────────

describe("table rendering edge cases", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
  });

  it("handles very long cell value (200+ characters)", () => {
    consoleSpy = createConsoleSpy();
    const longValue = "x".repeat(250);
    expect(() => renderTable(["Name", "Description"], [["test", longValue]])).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("x".repeat(50));
  });

  it("handles cell with newline characters", () => {
    consoleSpy = createConsoleSpy();
    expect(() =>
      renderTable(["Key", "Value"], [["name", "line1\nline2\nline3"]]),
    ).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("name");
  });

  it("handles cell with Unicode content", () => {
    consoleSpy = createConsoleSpy();
    expect(() =>
      renderTable(["Emoji", "Text"], [["test", "\u2713 \u2717 \u26A0"]]),
    ).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("\u2713");
    expect(output).toContain("\u2717");
    expect(output).toContain("\u26A0");
  });

  it("handles renderTable with many rows (100 rows)", () => {
    consoleSpy = createConsoleSpy();
    const rows = Array.from({ length: 100 }, (_, i) => [`row-${i}`, `value-${i}`]);
    expect(() => renderTable(["ID", "Value"], rows)).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("row-0");
    expect(output).toContain("row-99");
  });

  it("handles renderKeyValue with very long key", () => {
    consoleSpy = createConsoleSpy();
    const longKey = "VeryLongKeyNameThatGoesOnAndOn".repeat(3);
    expect(() => renderKeyValue([[longKey, "value"]])).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("value");
  });

  it("handles renderTable with empty string cells", () => {
    consoleSpy = createConsoleSpy();
    expect(() =>
      renderTable(["A", "B"], [
        ["", ""],
        ["", ""],
      ]),
    ).not.toThrow();
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("A");
    expect(output).toContain("B");
  });
});

// ─── SIGINT during interactive prompts ─────────────────────────────────────

// Dynamic imports at file scope (top-level await is supported in ESM)
const p = await import("@clack/prompts");
const { Command } = await import("commander");
const { registerSessionsCommand } = await import("./sessions.js");
const { registerResetCommand } = await import("./reset.js");

describe("SIGINT during interactive prompts", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.mocked(p.confirm).mockReset();
    vi.mocked(p.isCancel).mockReset();
    vi.mocked(p.cancel).mockReset();
  });

  it("sessions delete handles prompt cancellation gracefully", async () => {
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(p.isCancel).mockReturnValue(true);

    const program = new Command().exitOverride();
    registerSessionsCommand(program);

    const initialWsCount = MockWebSocket.instances.length;

    await program.parseAsync(["node", "test", "sessions", "delete", "some-key"]);

    // Verify: withClient was NOT called (no new WebSocket created)
    expect(MockWebSocket.instances.length).toBe(initialWsCount);

    // Verify: cancel message was shown
    expect(p.cancel).toHaveBeenCalledWith("Delete cancelled.");
  });

  it("reset handles prompt cancellation gracefully", async () => {
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(p.isCancel).mockReturnValue(true);

    const program = new Command().exitOverride();
    registerResetCommand(program);

    const initialWsCount = MockWebSocket.instances.length;

    await program.parseAsync(["node", "test", "reset", "sessions"]);

    // Verify: withClient was NOT called (no new WebSocket created)
    expect(MockWebSocket.instances.length).toBe(initialWsCount);

    // Verify: cancel message was shown
    expect(p.cancel).toHaveBeenCalledWith("Reset cancelled.");
  });
});
