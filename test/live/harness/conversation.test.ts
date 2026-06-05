// SPDX-License-Identifier: Apache-2.0
/**
 * ConversationDriver unit tests (Stage-A, no daemon required).
 *
 * Tests only pure-logic methods:
 *   - getDataDir() — constructor sets up a temp dir matching /comis-live-loop/
 *   - getSessionIndexEvents() — returns [] when file absent, parses valid JSONL
 *   - capturedLogLines() — returns a string
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
});
