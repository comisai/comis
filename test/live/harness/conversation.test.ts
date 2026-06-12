// SPDX-License-Identifier: Apache-2.0
/**
 * ConversationDriver unit tests (Stage-A, no daemon required).
 *
 * Tests only pure-logic methods:
 *   - getDataDir() — constructor sets up a temp dir matching /comis-live-loop/
 *   - getSessionIndexEvents() — returns [] when file absent, parses valid JSONL
 *   - capturedLogLines() — returns a string
 *   - capturedEvents() — returns [] initially; captures events after subscription
 *
 * sendTurn() is tested only in integration (live scenarios with a real daemon),
 * because it requires an open WebSocket to a running daemon.
 *
 * Uses StubDriver — a subclass that overrides init() and close() to no-ops so
 * no real daemon is started in unit-test context.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventBus } from "@comis/core";
import { ConversationDriver, type ConversationDriverOptions } from "./conversation.js";

// ---------------------------------------------------------------------------
// StubDriver — overrides daemon-facing methods so unit tests run without boot
// ---------------------------------------------------------------------------

class StubDriver extends ConversationDriver {
  constructor(overrideDataDir?: string) {
    super({ agentId: "stub", provider: "anthropic" });
    if (overrideDataDir) {
      // Access the protected _dataDir field set in the constructor
      (this as unknown as { _dataDir: string })._dataDir = overrideDataDir;
    }
  }

  override async init(): Promise<void> {
    // no-op: no daemon boot in unit tests
  }

  override async close(): Promise<void> {
    // no-op
  }

  override capturedLogLines(): string {
    return "";
  }
}

/**
 * StubDriverWithBus — StubDriver that accepts a mock TypedEventBus handle so
 * unit tests can exercise capturedEvents() without booting a real daemon.
 *
 * Calls injectEventBus(bus) after construction to wire the subscription loop
 * that capturedEvents() relies on, emulating what init() does with a real daemon.
 */
class StubDriverWithBus extends ConversationDriver {
  constructor() {
    super({ agentId: "stub-bus", provider: "anthropic" });
  }

  override async init(): Promise<void> {
    // no-op: no daemon boot in unit tests
  }

  override async close(): Promise<void> {
    // no-op
  }

  override capturedLogLines(): string {
    return "";
  }

  /** Expose the internal subscription wiring so tests can inject a mock bus. */
  injectEventBus(bus: TypedEventBus): void {
    (this as unknown as { _subscribeToEventBus: (b: TypedEventBus) => void })._subscribeToEventBus(bus);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ConversationDriver — unit (Stage-A, no daemon required)", () => {
  it("ConversationDriverOptions type is importable and accepts no fields", () => {
    // TypeScript static check: this compiles iff the type is exported and allows
    // an empty object (all fields are optional).
    const _opts: ConversationDriverOptions = {};
    expect(_opts).toBeDefined();
  });

  it("getDataDir() returns a string matching /comis-live-loop/", () => {
    const driver = new StubDriver();
    expect(driver.getDataDir()).toMatch(/comis-live-loop/);
  });

  it("getSessionIndexEvents() returns [] when session-index file does not exist", async () => {
    const driver = new StubDriver();
    const events = await driver.getSessionIndexEvents();
    expect(events).toEqual([]);
  });

  it("getMemoryDbPath() resolves a RELATIVE memory.dbPath against the daemon's dataDir", () => {
    // 260611 live-fire fix: scenario files hand-built join(dataDir,"memory.db"),
    // which never matched config.test.yaml's dbPath "test-memory-default.db" —
    // every existsSync-guarded db-oracle silently skipped (§2.10 bug class).
    const driver = new StubDriver();
    (driver as unknown as { _handle: unknown })._handle = {
      daemon: { container: { config: { dataDir: "/data/root", memory: { dbPath: "test-memory-default.db" } } } },
    };
    expect(driver.getMemoryDbPath()).toBe(join("/data/root", "test-memory-default.db"));
  });

  it("getMemoryDbPath() returns an ABSOLUTE memory.dbPath unchanged", () => {
    const driver = new StubDriver();
    (driver as unknown as { _handle: unknown })._handle = {
      daemon: { container: { config: { dataDir: "/data/root", memory: { dbPath: "/abs/elsewhere.db" } } } },
    };
    expect(driver.getMemoryDbPath()).toBe("/abs/elsewhere.db");
  });

  it("getMemoryDbPath() falls back to the driver dataDir when config.dataDir is empty", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-test-dbp-"));
    const driver = new StubDriver(dataDir);
    (driver as unknown as { _handle: unknown })._handle = {
      daemon: { container: { config: { dataDir: "", memory: { dbPath: "memory.db" } } } },
    };
    expect(driver.getMemoryDbPath()).toBe(join(dataDir, "memory.db"));
  });

  it("getMemoryDbPath() throws before init() (no handle)", () => {
    const driver = new StubDriver();
    expect(() => driver.getMemoryDbPath()).toThrow(/init\(\)/);
  });

  it("getSessionIndexEvents() parses valid JSONL", async () => {
    // Create a temp dir with a session-index JSONL file containing one event
    const dataDir = mkdtempSync(join(tmpdir(), "comis-test-si-"));
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const indexPath = join(logsDir, `session-index.${today}.jsonl`);

    const event = {
      event: "session_ended",
      sessionId: "s1",
      exitReason: "cleanup",
      turnCount: 2,
      totalTokens: 100,
      traceSchema: "comis-session-index",
      schemaVersion: 1,
      ts: "2026-06-05T00:00:00.000Z",
    };
    writeFileSync(indexPath, JSON.stringify(event) + "\n", "utf-8");

    const driver = new StubDriver(dataDir);
    const result = await driver.getSessionIndexEvents();

    expect(result).toHaveLength(1);
    expect(result[0]?.event).toBe("session_ended");
    // TypeScript narrowing — access turnCount via the discriminated union
    const ended = result[0] as { event: string; turnCount: number };
    expect(ended.turnCount).toBe(2);
  });

  it("capturedLogLines() returns a string", () => {
    const driver = new StubDriver();
    expect(typeof driver.capturedLogLines()).toBe("string");
  });

  // -------------------------------------------------------------------------
  // capturedEvents() tests
  // -------------------------------------------------------------------------

  it("capturedEvents() returns an empty array before any events are emitted", () => {
    const driver = new StubDriver();
    expect(driver.capturedEvents()).toEqual([]);
  });

  it("capturedEvents() returns an array (type check)", () => {
    const driver = new StubDriver();
    const events = driver.capturedEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  it("capturedEvents() captures context:dag_compacted events emitted on the injected eventBus", () => {
    // Arrange: create a real TypedEventBus and inject it into a StubDriverWithBus
    const driver = new StubDriverWithBus();
    const bus = new TypedEventBus();
    driver.injectEventBus(bus);

    // Assert: no events before emit
    expect(driver.capturedEvents()).toHaveLength(0);

    // Act: emit a context:dag_compacted event on the bus
    bus.emit("context:dag_compacted", {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: { channelId: "echo", channelType: "echo", userId: "u1", conversationId: "conv-1" },
      leafSummariesCreated: 3,
      condensedSummariesCreated: 0,
      maxDepthReached: 1,
      totalSummariesCreated: 3,
      durationMs: 42,
      timestamp: Date.now(),
    });

    // Assert: capturedEvents() returns the emitted event
    const events = driver.capturedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("context:dag_compacted");
    const payload = events[0]?.payload as { leafSummariesCreated: number };
    expect(payload.leafSummariesCreated).toBe(3);
  });

  it("capturedEvents() returns a copy (mutations do not affect internal state)", () => {
    const driver = new StubDriverWithBus();
    const bus = new TypedEventBus();
    driver.injectEventBus(bus);

    bus.emit("context:dag_compacted", {
      conversationId: "conv-2",
      agentId: "agent-2",
      sessionKey: { channelId: "echo", channelType: "echo", userId: "u2", conversationId: "conv-2" },
      leafSummariesCreated: 1,
      condensedSummariesCreated: 0,
      maxDepthReached: 1,
      totalSummariesCreated: 1,
      durationMs: 10,
      timestamp: Date.now(),
    });

    const copy1 = driver.capturedEvents();
    copy1.push({ name: "injected", payload: {} }); // mutate the copy
    const copy2 = driver.capturedEvents();

    // The mutation must NOT have leaked into internal state
    expect(copy2).toHaveLength(1);
    expect(copy2[0]?.name).toBe("context:dag_compacted");
  });
});

// ---------------------------------------------------------------------------
// parseAgentExecuteResult — 260611 live-fire fix. The gateway returns
// { response, tokensUsed, finishReason } (rpc-adapters.ts handleAgentRequest);
// the driver previously read `result.reply` (never existed) so every live turn
// threw even when the model answered. Handler failures arrive as result.error
// (string), not a JSON-RPC error object.
// ---------------------------------------------------------------------------

describe("parseAgentExecuteResult — agent.execute envelope parsing", () => {
  it("returns result.response (the REAL gateway field — not 'reply')", async () => {
    const { parseAgentExecuteResult } = await import("./conversation.js");
    expect(
      parseAgentExecuteResult({ result: { response: "330 meters." } }),
    ).toBe("330 meters.");
  });

  it("returns a degraded-but-honest fallback reply instead of throwing (oracles judge it)", async () => {
    const { parseAgentExecuteResult } = await import("./conversation.js");
    expect(
      parseAgentExecuteResult({
        result: { response: "The AI didn't produce a response.", finishReason: "error" },
      }),
    ).toBe("The AI didn't produce a response.");
  });

  it("throws on a JSON-RPC error envelope", async () => {
    const { parseAgentExecuteResult } = await import("./conversation.js");
    expect(() =>
      parseAgentExecuteResult({ error: { code: -32000, message: "boom" } }),
    ).toThrow(/RPC error -32000/);
  });

  it("throws on handler-level result.error (string shape)", async () => {
    const { parseAgentExecuteResult } = await import("./conversation.js");
    expect(() =>
      parseAgentExecuteResult({ result: { error: "Missing required parameter: message (string)" } }),
    ).toThrow(/handler error: Missing required parameter/);
  });

  it("throws on a missing/empty response string", async () => {
    const { parseAgentExecuteResult } = await import("./conversation.js");
    expect(() => parseAgentExecuteResult({ result: {} })).toThrow(/no response string/);
    expect(() => parseAgentExecuteResult({ result: { response: "" } })).toThrow(/no response string/);
  });
});
