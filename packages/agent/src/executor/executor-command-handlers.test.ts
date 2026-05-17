// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for applyCommandDirectives — the executor's command-directive handler.
 *
 * applyCommandDirectives runs as a per-execute() step that, when a directive
 * package is attached to the incoming message, invokes the SDK session's
 * thinkingLevel / compact / setModel / cycleModel / exportToHtml /
 * navigateTree surface. Each directive branch is a self-contained try/catch
 * that mutates `result` (sets response text and finishReason) or emits a
 * structured log.
 *
 * These tests stub the CommandSession with vi.fn() spies and assert that
 * (a) the right SDK method is invoked with the right arguments,
 * (b) the result object gets the right response + finishReason,
 * (c) errors are caught and surfaced as logged WARN with the correct
 * errorKind tag, and
 * (d) safePath rejects export paths containing traversal segments.
 *
 * Use-case design: every `it("...")` description names a use case ≥20 chars
 * ending in a recognizable shape.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { applyCommandDirectives, type CommandSession, type CommandHandlerDeps } from "./executor-command-handlers.js";
import type { CommandDirectives } from "./command-directive-types.js";
import type { ExecutionResult } from "./types.js";
import type { SessionKey } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SESSION_KEY: SessionKey = {
  tenantId: "tenant-a",
  userId: "user_a",
  channelId: "chan-a",
};

function makeSession(overrides: Partial<CommandSession> = {}): CommandSession {
  return {
    setThinkingLevel: vi.fn(),
    compact: vi.fn().mockResolvedValue({ tokensBefore: 1234 }),
    setModel: vi.fn().mockResolvedValue(undefined),
    cycleModel: vi.fn().mockResolvedValue({ model: { id: "next-model" } }),
    exportToHtml: vi.fn().mockResolvedValue("/tmp/session-export.html"),
    navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
    getUserMessagesForForking: vi.fn().mockReturnValue([
      { entryId: "msg-1", text: "first user message" },
      { entryId: "msg-2", text: "second user message" },
    ]),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<CommandHandlerDeps>): CommandHandlerDeps {
  return {
    logger: createMockLogger(),
    eventBus: new TypedEventBus(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ModelRegistry is the SDK type; tests only need find()
    modelRegistry: { find: vi.fn().mockReturnValue({ id: "found-model", provider: "anthropic" }) } as any,
    workspaceDir: "/tmp/workspace",
    clock: createFakeClock(1_700_000_000_000),
    ...overrides,
  };
}

function makeResult(): ExecutionResult {
  // applyCommandDirectives mutates only `response` and `finishReason`; other
  // fields are owned upstream. Cast via `unknown` because applyCommandDirectives
  // never reads them — the partial fixture is safe at the test boundary.
  return { response: "", finishReason: undefined } as unknown as ExecutionResult;
}

const TEST_CONFIG = { provider: "anthropic" };

// ---------------------------------------------------------------------------
// applyCommandDirectives — top-level branching
// ---------------------------------------------------------------------------

describe("applyCommandDirectives — top-level early returns and branch dispatch", () => {
  it("returns hasCommandDirective=false when directives are undefined (no work to do)", async () => {
    const r = await applyCommandDirectives({
      directives: undefined,
      session: makeSession(),
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(r.hasCommandDirective).toBe(false);
  });

  it("returns hasCommandDirective=false when directives object has only thinkingLevel (advisory, not command-only)", async () => {
    // thinkingLevel adjusts SDK state but is NOT a command-only directive --
    // it does not short-circuit the executor.
    const session = makeSession();
    const r = await applyCommandDirectives({
      directives: { thinkingLevel: "low" } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(r.hasCommandDirective).toBe(false);
    expect(session.setThinkingLevel).toHaveBeenCalledWith("low");
  });
});

// ---------------------------------------------------------------------------
// thinkingLevel directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.thinkingLevel — SDK setThinkingLevel passthrough with error capture", () => {
  it("forwards the requested level string to session.setThinkingLevel() unchanged", async () => {
    const session = makeSession();
    await applyCommandDirectives({
      directives: { thinkingLevel: "medium" } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.setThinkingLevel).toHaveBeenCalledWith("medium");
  });

  it("logs a WARN with errorKind=config when session.setThinkingLevel() throws (fallback path)", async () => {
    const setThinkingLevelError = new Error("SDK rejected level");
    const session = makeSession({
      setThinkingLevel: vi.fn(() => {
        throw setThinkingLevelError;
      }),
    });
    const logger = createMockLogger();
    await applyCommandDirectives({
      directives: { thinkingLevel: "high" } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps({ logger }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: setThinkingLevelError,
        thinkingLevel: "high",
        errorKind: "config",
      }),
      "setThinkingLevel failed",
    );
  });
});

// ---------------------------------------------------------------------------
// compact directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.compact — SDK compact() invocation and event emission", () => {
  it("invokes session.compact() with the instructions string when directives.compact is an object", async () => {
    const session = makeSession();
    await applyCommandDirectives({
      directives: { compact: { verbose: false, instructions: "trim aggressively" } } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.compact).toHaveBeenCalledWith("trim aggressively");
  });

  it("emits compaction:flush on the event bus with trigger=manual and timestamp from injected ClockPort", async () => {
    const session = makeSession();
    const bus = new TypedEventBus();
    const captured: Array<{ name: string; payload: unknown }> = [];
    bus.on("compaction:flush", (p) => captured.push({ name: "compaction:flush", payload: p }));
    const fakeClock = createFakeClock(1_700_000_999_999);

    await applyCommandDirectives({
      directives: { compact: true } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps({ eventBus: bus, clock: fakeClock }),
      sessionKey: TEST_SESSION_KEY,
    });

    expect(captured.length).toBe(1);
    expect(captured[0].payload).toMatchObject({
      trigger: "manual",
      success: true,
      timestamp: 1_700_000_999_999,
    });
  });

  it("returns hasCommandDirective=true even when session.compact() rejects (compact is command-only)", async () => {
    const session = makeSession({
      compact: vi.fn().mockRejectedValue(new Error("compaction blew up")),
    });
    const r = await applyCommandDirectives({
      directives: { compact: true } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(r.hasCommandDirective).toBe(true);
  });

  it("logs a WARN with errorKind=internal when session.compact() rejects (operator can correlate)", async () => {
    const compactError = new Error("compaction blew up");
    const session = makeSession({
      compact: vi.fn().mockRejectedValue(compactError),
    });
    const logger = createMockLogger();
    await applyCommandDirectives({
      directives: { compact: true } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps({ logger }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: compactError, errorKind: "internal" }),
      "Manual compaction error",
    );
  });
});

// ---------------------------------------------------------------------------
// modelSwitch directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.modelSwitch — SDK setModel via modelRegistry lookup", () => {
  it("calls session.setModel() with the registry-resolved model and writes a confirmation response on success", async () => {
    const resolvedModel = { id: "claude-sonnet-4-5", provider: "anthropic" };
    const session = makeSession();
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ModelRegistry SDK type
      modelRegistry: { find: vi.fn().mockReturnValue(resolvedModel) } as any,
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: {
        modelSwitch: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps,
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.setModel).toHaveBeenCalledWith(resolvedModel);
    expect(result.response).toBe("Model switched to anthropic/claude-sonnet-4-5");
    expect(result.finishReason).toBe("stop");
  });

  it("writes 'Unknown model' to result.response when modelRegistry.find() returns undefined", async () => {
    const session = makeSession();
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ModelRegistry SDK type
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: {
        modelSwitch: { provider: "openai", modelId: "ghost-model" },
      } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps,
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(result.response).toBe("Unknown model: openai/ghost-model");
    expect(result.finishReason).toBe("stop");
  });

  it("logs a WARN with errorKind=auth when session.setModel() rejects (API key may be invalid)", async () => {
    const setModelError = new Error("Invalid API key");
    const session = makeSession({
      setModel: vi.fn().mockRejectedValue(setModelError),
    });
    const logger = createMockLogger();
    const result = makeResult();
    await applyCommandDirectives({
      directives: {
        modelSwitch: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps({ logger }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: setModelError, errorKind: "auth", provider: "anthropic" }),
      "Model switch failed",
    );
    expect(result.response).toContain("Failed to switch model: Invalid API key");
  });
});

// ---------------------------------------------------------------------------
// modelCycle directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.modelCycle — SDK cycleModel with direction (default forward)", () => {
  it("invokes session.cycleModel('forward') when direction is omitted from the directive", async () => {
    const session = makeSession();
    await applyCommandDirectives({
      directives: { modelCycle: {} } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.cycleModel).toHaveBeenCalledWith("forward");
  });

  it("writes the cycled model id to result.response when session.cycleModel() succeeds", async () => {
    const session = makeSession({
      cycleModel: vi.fn().mockResolvedValue({ model: { id: "claude-opus-4-1" } }),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { modelCycle: { direction: "backward" } } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.cycleModel).toHaveBeenCalledWith("backward");
    expect(result.response).toBe("Model cycled to: claude-opus-4-1");
    expect(result.finishReason).toBe("stop");
  });

  it("logs a WARN with errorKind=internal and surfaces the error message when cycleModel() rejects", async () => {
    const cycleError = new Error("registry empty");
    const session = makeSession({
      cycleModel: vi.fn().mockRejectedValue(cycleError),
    });
    const logger = createMockLogger();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { modelCycle: {} } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps({ logger }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: cycleError, errorKind: "internal" }),
      "Model cycle error",
    );
    expect(result.response).toBe("Model cycle failed: registry empty");
  });
});

// ---------------------------------------------------------------------------
// exportSession directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.exportSession — exportToHtml + safePath traversal guard", () => {
  it("invokes session.exportToHtml() with no path when directive omits outputPath", async () => {
    const session = makeSession();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { exportSession: {} } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.exportToHtml).toHaveBeenCalledWith(undefined);
    expect(result.response).toBe("Session exported to: /tmp/session-export.html");
    expect(result.finishReason).toBe("stop");
  });

  it("rejects an outputPath containing '..' traversal segments before calling exportToHtml() (safePath)", async () => {
    const session = makeSession();
    const logger = createMockLogger();
    const result = makeResult();
    await applyCommandDirectives({
      directives: {
        exportSession: { outputPath: "../../etc/passwd.html" },
      } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps({ logger, workspaceDir: "/tmp/workspace" }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.exportToHtml).not.toHaveBeenCalled();
    expect(result.response).toBe("Invalid export path");
    expect(result.finishReason).toBe("stop");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "validation" }),
      "Invalid export path rejected",
    );
  });

  it("writes finishReason=error when session.exportToHtml() rejects (export failures are terminal)", async () => {
    const exportError = new Error("disk full");
    const session = makeSession({
      exportToHtml: vi.fn().mockRejectedValue(exportError),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { exportSession: {} } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(result.response).toBe("Export failed: disk full");
    expect(result.finishReason).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// forkSession directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.forkSession — navigateTree to the latest user message", () => {
  it("writes 'No user messages to fork from.' when getUserMessagesForForking() returns an empty array", async () => {
    const session = makeSession({
      getUserMessagesForForking: vi.fn().mockReturnValue([]),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { forkSession: true } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.navigateTree).not.toHaveBeenCalled();
    expect(result.response).toBe("No user messages to fork from.");
    expect(result.finishReason).toBe("stop");
  });

  it("navigates to the entryId of the LAST element returned by getUserMessagesForForking() (most recent)", async () => {
    const session = makeSession();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { forkSession: true } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    // makeSession fixture returns two messages; the last (msg-2) is the fork target.
    expect(session.navigateTree).toHaveBeenCalledWith("msg-2");
    expect(result.response).toBe('Forked from: "second user message"');
    expect(result.finishReason).toBe("stop");
  });

  it("truncates the fork preview to 80 chars and appends '...' when the source text exceeds 80 chars", async () => {
    const longText = "x".repeat(100);
    const session = makeSession({
      getUserMessagesForForking: vi.fn().mockReturnValue([{ entryId: "msg-long", text: longText }]),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { forkSession: true } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(result.response).toBe(`Forked from: "${"x".repeat(80)}..."`);
  });

  it("writes 'Fork cancelled.' when navigateTree() returns cancelled=true", async () => {
    const session = makeSession({
      navigateTree: vi.fn().mockResolvedValue({ cancelled: true }),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { forkSession: true } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(result.response).toBe("Fork cancelled.");
    expect(result.finishReason).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// branchAction directive
// ---------------------------------------------------------------------------

describe("applyCommandDirectives.branchAction — list branch points OR navigate to a specific id", () => {
  it("lists all available branch points with id and preview when branchAction has no targetId", async () => {
    const session = makeSession();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { branchAction: {} } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.navigateTree).not.toHaveBeenCalled();
    expect(result.response).toContain("**Branch Points**");
    expect(result.response).toContain("`msg-1`");
    expect(result.response).toContain("`msg-2`");
    expect(result.response).toContain("Use `/branch <id>` to navigate");
  });

  it("writes 'No branch points available.' when getUserMessagesForForking() returns an empty list (no targetId)", async () => {
    const session = makeSession({
      getUserMessagesForForking: vi.fn().mockReturnValue([]),
    });
    const result = makeResult();
    await applyCommandDirectives({
      directives: { branchAction: {} } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(result.response).toBe("No branch points available.");
  });

  it("navigates to the provided targetId and writes a confirmation when navigateTree() succeeds", async () => {
    const session = makeSession();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { branchAction: { targetId: "msg-3" } } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(session.navigateTree).toHaveBeenCalledWith("msg-3");
    expect(result.response).toBe("Navigated to branch: msg-3");
    expect(result.finishReason).toBe("stop");
  });

  it("writes finishReason=error when navigateTree() rejects with a thrown error (branch navigation failed)", async () => {
    const navError = new Error("branch missing");
    const session = makeSession({
      navigateTree: vi.fn().mockRejectedValue(navError),
    });
    const logger = createMockLogger();
    const result = makeResult();
    await applyCommandDirectives({
      directives: { branchAction: { targetId: "msg-3" } } as CommandDirectives,
      session,
      result,
      config: TEST_CONFIG,
      deps: makeDeps({ logger }),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(result.response).toBe("Branch navigation failed: branch missing");
    expect(result.finishReason).toBe("error");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: navError, errorKind: "internal" }),
      "Branch navigate error",
    );
  });
});

// ---------------------------------------------------------------------------
// Combined directives — interaction semantics
// ---------------------------------------------------------------------------

describe("applyCommandDirectives — combined directives keep hasCommandDirective sticky once set", () => {
  it("returns hasCommandDirective=true when compact and exportSession are both requested in one call", async () => {
    const session = makeSession();
    const r = await applyCommandDirectives({
      directives: {
        compact: true,
        exportSession: {},
      } as CommandDirectives,
      session,
      result: makeResult(),
      config: TEST_CONFIG,
      deps: makeDeps(),
      sessionKey: TEST_SESSION_KEY,
    });
    expect(r.hasCommandDirective).toBe(true);
    expect(session.compact).toHaveBeenCalled();
    expect(session.exportToHtml).toHaveBeenCalled();
  });
});
