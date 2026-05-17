// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for drain-helper — inline-consumption drain seams invoked from the
 * bridge's `tool_execution_end` event.
 *
 * The drain helpers (markRead / markConsumed / drainAt) are observability
 * stubs today: when invoked outside an AsyncLocalStorage RequestContext
 * scope they are silent no-ops; inside a scope they emit DEBUG logs with
 * the composite key + traceId. `drainAt` adds a per-composite-key
 * single-tick inflight gate so concurrent drains for the same key collapse
 * to one execution while drains for DIFFERENT keys run independently.
 *
 * Use-case design: every `it("...")` description names a use case ≥20 chars
 * ending in a recognizable shape.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  formatDrainKey,
  markRead,
  markConsumed,
  drainAt,
  type DrainKey,
  type DrainInflightState,
} from "./drain-helper.js";
import { runWithContext, type RequestContext } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDrainKey(overrides: Partial<DrainKey> = {}): DrainKey {
  return {
    agentId: "agent-a",
    channelType: "test",
    channelId: "chan-a",
    ...overrides,
  };
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "default",
    userId: "user_a@example.com",
    sessionKey: "default:user_a@example.com:chan-a",
    traceId: randomUUID(),
    startedAt: 1_700_000_000_000,
    trustLevel: "admin",
    ...overrides,
  };
}

function makeInflightState(): DrainInflightState {
  return { drainInflightByKey: new Map<string, Promise<void>>() };
}

// ---------------------------------------------------------------------------
// formatDrainKey
// ---------------------------------------------------------------------------

describe("formatDrainKey — deterministic composite key serialization", () => {
  it("joins agentId/channelType/channelId with colons in a stable left-to-right order", () => {
    const key = makeDrainKey({ agentId: "ag-1", channelType: "discord", channelId: "ch-42" });
    expect(formatDrainKey(key)).toBe("ag-1:discord:ch-42");
  });

  it("returns identical strings for identical key triples (deterministic input -> deterministic output)", () => {
    const a = makeDrainKey({ agentId: "x", channelType: "y", channelId: "z" });
    const b = makeDrainKey({ agentId: "x", channelType: "y", channelId: "z" });
    expect(formatDrainKey(a)).toBe(formatDrainKey(b));
  });

  it("returns different strings when any single field of the triple differs (no field collisions)", () => {
    const base = formatDrainKey(makeDrainKey({ agentId: "a", channelType: "b", channelId: "c" }));
    expect(formatDrainKey(makeDrainKey({ agentId: "A", channelType: "b", channelId: "c" }))).not.toBe(base);
    expect(formatDrainKey(makeDrainKey({ agentId: "a", channelType: "B", channelId: "c" }))).not.toBe(base);
    expect(formatDrainKey(makeDrainKey({ agentId: "a", channelType: "b", channelId: "C" }))).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// markRead
// ---------------------------------------------------------------------------

describe("markRead — no-op outside AsyncLocalStorage, observability DEBUG inside scope", () => {
  it("is a silent no-op when invoked outside any runWithContext scope (no log emitted)", () => {
    const logger = createMockLogger();
    markRead(makeDrainKey(), logger);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("emits a DEBUG log with submodule=drain.markRead when invoked inside a runWithContext scope", () => {
    const logger = createMockLogger();
    const ctx = makeContext();
    runWithContext(ctx, () => {
      markRead(makeDrainKey({ agentId: "ag-7", channelType: "slack", channelId: "C-99" }), logger);
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        submodule: "drain.markRead",
        agentId: "ag-7",
        channelType: "slack",
        channelId: "C-99",
        traceId: ctx.traceId,
      }),
      "markRead",
    );
  });
});

// ---------------------------------------------------------------------------
// markConsumed
// ---------------------------------------------------------------------------

describe("markConsumed — no-op outside AsyncLocalStorage, observability DEBUG inside scope", () => {
  it("is a silent no-op when invoked outside any runWithContext scope (no log emitted)", () => {
    const logger = createMockLogger();
    markConsumed(makeDrainKey(), logger);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("emits a DEBUG log with submodule=drain.markConsumed when invoked inside a runWithContext scope", () => {
    const logger = createMockLogger();
    const ctx = makeContext();
    runWithContext(ctx, () => {
      markConsumed(makeDrainKey({ agentId: "ag-c", channelType: "irc", channelId: "#room" }), logger);
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        submodule: "drain.markConsumed",
        agentId: "ag-c",
        channelType: "irc",
        channelId: "#room",
        traceId: ctx.traceId,
      }),
      "markConsumed",
    );
  });
});

// ---------------------------------------------------------------------------
// drainAt
// ---------------------------------------------------------------------------

describe("drainAt — composite-keyed inline-consumption drain with single-tick gate", () => {
  it("registers exactly one inflight Promise per composite key on first call (Map size grows by one)", () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    drainAt(makeDrainKey({ agentId: "ag-1", channelType: "t", channelId: "c-1" }), state, logger);
    expect(state.drainInflightByKey.size).toBe(1);
    expect(state.drainInflightByKey.has("ag-1:t:c-1")).toBe(true);
  });

  it("deletes the inflight Map entry after the drain promise settles (no unbounded growth)", async () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    const key = makeDrainKey({ agentId: "ag-1", channelType: "t", channelId: "c-1" });
    drainAt(key, state, logger);
    // Wait for the inflight promise to settle. drainAt installs the promise
    // into the Map synchronously; the .finally cleanup runs after a tick.
    const inflight = state.drainInflightByKey.get("ag-1:t:c-1");
    expect(inflight).toBeDefined();
    await inflight;
    expect(state.drainInflightByKey.has("ag-1:t:c-1")).toBe(false);
    expect(state.drainInflightByKey.size).toBe(0);
  });

  it("returns immediately for a second concurrent call on the SAME composite key (single-tick gate collapses calls)", async () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    const key = makeDrainKey({ agentId: "ag-1", channelType: "t", channelId: "c-1" });
    drainAt(key, state, logger);
    const firstInflight = state.drainInflightByKey.get("ag-1:t:c-1");
    // Second call must NOT replace the existing inflight entry.
    drainAt(key, state, logger);
    expect(state.drainInflightByKey.get("ag-1:t:c-1")).toBe(firstInflight);
    expect(state.drainInflightByKey.size).toBe(1);
    await firstInflight;
  });

  it("registers independent inflight entries for DIFFERENT composite keys (multi-agent isolation preserved)", async () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    drainAt(makeDrainKey({ agentId: "ag-a", channelType: "t", channelId: "c-1" }), state, logger);
    drainAt(makeDrainKey({ agentId: "ag-b", channelType: "t", channelId: "c-1" }), state, logger);
    expect(state.drainInflightByKey.size).toBe(2);
    expect(state.drainInflightByKey.has("ag-a:t:c-1")).toBe(true);
    expect(state.drainInflightByKey.has("ag-b:t:c-1")).toBe(true);
    await Promise.all([...state.drainInflightByKey.values()]);
  });

  it("does NOT emit a logger.debug for outside-context drains and does not crash (silent no-op path)", async () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    drainAt(makeDrainKey(), state, logger);
    await Promise.all([...state.drainInflightByKey.values()]);
    // Outside a runWithContext scope, both markRead and markConsumed are
    // no-ops, so no DEBUG observability log fires.
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("emits two DEBUG logs (markRead + markConsumed) inside a runWithContext scope per drain pass", async () => {
    const logger = createMockLogger();
    const state = makeInflightState();
    const key = makeDrainKey({ agentId: "ag-1", channelType: "t", channelId: "c-1" });
    await new Promise<void>((resolve) => {
      runWithContext(makeContext(), () => {
        drainAt(key, state, logger);
        const inflight = state.drainInflightByKey.get("ag-1:t:c-1");
        // Resolve after the drain pass settles -- ALS is still in scope
        // through the chained .then/await per Node's AsyncLocalStorage
        // propagation guarantee.
        inflight!.then(() => resolve()).catch(() => resolve());
      });
    });
    const debugCalls = (logger.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const markReadCalls = debugCalls.filter((c) => c[1] === "markRead");
    const markConsumedCalls = debugCalls.filter((c) => c[1] === "markConsumed");
    expect(markReadCalls.length).toBe(1);
    expect(markConsumedCalls.length).toBe(1);
  });
});
