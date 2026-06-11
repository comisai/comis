// SPDX-License-Identifier: Apache-2.0
/**
 * Structural tests for the retry-loop module entry point.
 *
 * Behavioral coverage of the model retry pipeline lives in
 * model-retry.test.ts (the underlying retry-with-failover helper) and the
 * integration suite. This file pins the stuck-session early-return shape
 * + the silent-failure delegation to silent-failure-handlers.ts.
 *
 * Why source-grep here: invoking runRetryLoop requires a fully wired
 * AgentSession + ModelRegistry + the deps surface — same cost barrier as
 * the orchestrator test. The branch dispatch is pinned structurally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { hostileMcpTool } from "../../provider/tool-schema/gbnf-hostile-fixtures.js";
import { setSessionStateClock } from "../executor-session-state.js";
import { runWithModelRetry } from "../model-retry.js";
import { PromptTimeoutError } from "../prompt-timeout.js";
import type { ExecutionResult } from "../types.js";
import { processFailurePath } from "./failure-path.js";
import type { RunPromptParams } from "./prompt-runner-types.js";
import { runRetryLoop, stuckSessionResult } from "./retry-loop.js";

// Module-level clock for executor-session-state's bounded session map (the
// CR-02 session-lifetime strip once-gate lives there).
setSessionStateClock({ now: () => Date.now(), nowDate: () => new Date() });

// Mock ONLY runWithModelRetry (the behavioral dispatch tests below drive the
// REAL classifier + REAL silent-failure handlers); isAuthError and the rest
// of model-retry stay real for the handlers that import them.
vi.mock("../model-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-retry.js")>();
  return { ...actual, runWithModelRetry: vi.fn() };
});

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "retry-loop.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("retry-loop.ts — module surface", () => {
  it("exports runRetryLoop (async) and stuckSessionResult", () => {
    expect(typeof runRetryLoop).toBe("function");
    expect(typeof stuckSessionResult).toBe("function");
  });

  it("stuckSessionResult returns the canonical stuck-session PromptRunResult", () => {
    expect(stuckSessionResult()).toEqual({
      promptSucceeded: false,
      promptError: undefined,
      escalationAttempted: false,
      stuckSessionDetected: true,
    });
  });
});

describe("retry-loop.ts — stuck-session guard", () => {
  it("zero LLM calls + zero steps triggers early return with stuckSessionDetected: true", () => {
    // Structural lock on the stuck-session predicate.
    expect(source).toMatch(
      /\(stuckCheck\.llmCalls \?\? 0\)\s*===\s*0\s*&&\s*\(stuckCheck\.stepsExecuted \?\? 0\)\s*===\s*0/,
    );
    // And on the early-return shape.
    expect(source).toMatch(/return \{[^}]*stuckSessionDetected:\s*true[^}]*\}/);
  });

  it("Zero-LLM-call WARN log uses the canonical hint + errorKind", () => {
    expect(source).toMatch(/"Zero-LLM-call execution detected"/);
    expect(source).toMatch(/Session stuck: prompt returned with zero LLM calls/);
    expect(source).toMatch(/errorKind: "internal" as ErrorKind/);
  });
});

describe("retry-loop.ts — silent-failure delegation (dependency-direction)", () => {
  it("delegates to silent-failure-handlers for each classified branch", () => {
    expect(source).toMatch(/from\s+"\.\/silent-failure-handlers\.js"/);
    expect(source).toMatch(/handleSignedReplay/);
    expect(source).toMatch(/handleRateLimited/);
    expect(source).toMatch(/handleClientRequest/);
    expect(source).toMatch(/handleSilentRetryDefault/);
    expect(source).toMatch(/declareSilentTerminalFailure/);
  });

  it("does NOT import from prompt-runner.ts (dependency-direction)", () => {
    expect(source).not.toMatch(/from\s+"\.\/prompt-runner\.js"/);
  });

  it("imports types only from prompt-runner-types.ts", () => {
    expect(source).toMatch(/from\s+"\.\/prompt-runner-types\.js"/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral dispatch — tool_schema_unsupported (GBNF-02, Phase 175 Plan 05)
//
// Drives the REAL detectSilentFailure cascade (real classifyError, real
// silent-failure handlers) through runRetryLoop with only runWithModelRetry
// mocked. RED on pre-patch code: Plan 02's classifier already labels the
// llama-server body `tool_schema_unsupported`, but with no dispatch branch
// the category falls into handleSilentRetryDefault — the retry fires with
// UNSTRIPPED tools (the fallback-burn wrong-remedy) and no
// execution:tool_schema_unsupported event is emitted.
// ---------------------------------------------------------------------------

describe("detectSilentFailure dispatch — tool_schema_unsupported", () => {
  // FULL verbatim llama-server body (llama.cpp #19716) — re-inlined per plan
  // (no cross-test-file imports). Carries the `invalid_request_error` wrapper
  // that used to make client_request steal the match.
  const LLAMA_SERVER_GRAMMAR_400 =
    '{"error":{"code":400,"message":"JSON schema conversion failed:\\nUnrecognized schema: {\\"description\\":\\"Value for add/replace/test operations\\"}","type":"invalid_request_error"}}';

  function makeHostileTools(): Array<{ name: string; description?: string; parameters?: unknown }> {
    return [
      {
        name: hostileMcpTool.name,
        description: hostileMcpTool.description,
        parameters: structuredClone(hostileMcpTool.parameters),
      },
    ];
  }

  function makeDispatchParams(
    tools: Array<{ name: string; description?: string; parameters?: unknown }>,
    llmErrorBody: string,
    channelId: string,
  ): { params: RunPromptParams; emit: ReturnType<typeof vi.fn> } {
    const emit = vi.fn();
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    };
    const params = {
      session: {
        messages: [],
        getLastAssistantText: vi.fn(() => "recovered visible text"),
        followUp: vi.fn(async () => undefined),
      },
      sessionKey: { tenantId: "t1", userId: "u1", channelId },
      agentId: "agent-1",
      bridge: {
        getResult: vi.fn(() => ({
          llmCalls: 1,
          stepsExecuted: 1,
          textEmitted: false,
          finishReason: "error",
          lastLlmErrorMessage: llmErrorBody,
        })),
      },
      mergedCustomTools: tools,
      resolvedModel: { id: "qwen3.6:35b", provider: "my-ollama" },
      config: { provider: "my-ollama", model: "qwen3.6:35b" },
      effectiveTimeout: { promptTimeoutMs: 1000, retryPromptTimeoutMs: 1000 },
      onResetTimer: () => {},
      deps: {
        logger,
        eventBus: { emit },
        clock: { now: () => 5678 },
        timers: {
          setTimeout: (fn: () => void) => {
            fn();
            return { cancelled: false, cancel: () => {}, unref: () => {} };
          },
        },
        modelRegistry: { find: vi.fn(() => undefined) },
      },
    } as unknown as RunPromptParams;
    return { params, emit };
  }

  beforeEach(async () => {
    vi.mocked(runWithModelRetry).mockReset();
    // Optional pre-patch (export missing) — post-patch resets the module
    // once-gate between tests.
    const sfh = (await import("./silent-failure-handlers.js")) as Record<string, unknown>;
    (sfh.resetToolSchemaStripGateForTest as undefined | (() => void))?.();
  });

  it("grammar-400 on the SILENT path dispatches to the strip-retry handler: the single retry fires with STRIPPED tools and emits execution:tool_schema_unsupported", async () => {
    const tools = makeHostileTools();
    const capturedAtInvocation: string[] = [];
    vi.mocked(runWithModelRetry).mockImplementation(async () => {
      capturedAtInvocation.push(JSON.stringify(tools));
      return { succeeded: true };
    });
    const { params, emit } = makeDispatchParams(tools, LLAMA_SERVER_GRAMMAR_400, "c-dispatch-strip");

    const outcome = await runRetryLoop(params, "hello", undefined, false);

    // Initial prompt + exactly ONE strip-retry — never the full-ladder
    // re-entry shape and never a terminal generic failure.
    expect(vi.mocked(runWithModelRetry)).toHaveBeenCalledTimes(2);
    // The strip happened BEFORE the retry invocation (boundary observation;
    // pre-patch the default branch retries with the hostile schema intact).
    expect(capturedAtInvocation[1]).not.toContain('"pattern"');
    expect(capturedAtInvocation[1]).not.toContain('"format"');
    // handleClientRequest's terminal state did NOT occur.
    expect(String(outcome.promptError ?? "")).not.toContain("Client request rejected by provider");
    expect(outcome.promptSucceeded).toBe(true);
    // The obs chain input exists (Plan 06's explain heuristic consumes it).
    const events = emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported");
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      toolNames: ["schedule_task"],
      strippedKeywords: ["pattern", "format"],
      retried: true,
      succeeded: true,
    });
  });

  it("regression: a plain client_request body still takes the client_request terminal branch (byte-identical dispatch for existing categories)", async () => {
    vi.mocked(runWithModelRetry).mockResolvedValue({ succeeded: true });
    const { params, emit } = makeDispatchParams(
      makeHostileTools(),
      "unprocessable_entity: the request shape is invalid",
      "c-dispatch-client",
    );

    const outcome = await runRetryLoop(params, "hello", undefined, false);

    // No silent retry for deterministic client errors — one initial call only.
    expect(vi.mocked(runWithModelRetry)).toHaveBeenCalledTimes(1);
    expect(outcome.promptSucceeded).toBe(false);
    expect(String(outcome.promptError)).toContain("Client request rejected by provider");
    expect(emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // WR-01 (175-REVIEW): the THROWN path. When session.prompt() throws the
  // grammar-400, runWithModelRetry's GBNF-02 ladder guard returns
  // {succeeded:false, error} immediately — pre-fix runRetryLoop passed the
  // failure straight to output-escalation, where the canned userMessage
  // PROMISES "the agent will simplify the tool definition and try again
  // automatically" while no strip, no retry, and no
  // execution:tool_schema_unsupported event ever happened (obs-explain blind).
  // -------------------------------------------------------------------------

  it("WR-01: grammar-400 on the THROWN path dispatches to the strip-retry handler — strip + one retry + event, not a terminal false promise", async () => {
    const tools = makeHostileTools();
    const capturedAtInvocation: string[] = [];
    vi.mocked(runWithModelRetry)
      .mockImplementationOnce(async () => {
        capturedAtInvocation.push(JSON.stringify(tools));
        return { succeeded: false, error: new Error(LLAMA_SERVER_GRAMMAR_400) };
      })
      .mockImplementationOnce(async () => {
        capturedAtInvocation.push(JSON.stringify(tools));
        return { succeeded: true };
      });
    const { params, emit } = makeDispatchParams(tools, "", "c-thrown-strip");
    // Thrown path: the error never reached the bridge (no recorded LLM error
    // message) and the recovered retry emitted text.
    (params.bridge.getResult as ReturnType<typeof vi.fn>).mockReturnValue({
      llmCalls: 1,
      stepsExecuted: 1,
      textEmitted: true,
      finishReason: "stop",
      lastLlmErrorMessage: undefined,
    });

    const outcome = await runRetryLoop(params, "hello", undefined, false);

    // Initial (thrown) prompt + exactly ONE strip-retry.
    expect(vi.mocked(runWithModelRetry)).toHaveBeenCalledTimes(2);
    // The strip happened BEFORE the retry invocation.
    expect(capturedAtInvocation[0]).toContain('"pattern"');
    expect(capturedAtInvocation[1]).not.toContain('"pattern"');
    expect(capturedAtInvocation[1]).not.toContain('"format"');
    expect(outcome.promptSucceeded).toBe(true);
    // The obs chain sees the thrown path too.
    const events = emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported");
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      toolNames: ["schedule_task"],
      strippedKeywords: ["pattern", "format"],
      retried: true,
      succeeded: true,
    });
  });

  it("WR-01: gate-closed thrown-path failure carries the THROWN error body in promptError (bridge has no recorded LLM error) so failure-path classification stays correct", async () => {
    // Consume the session's one strip-retry via the thrown path.
    const tools = makeHostileTools();
    vi.mocked(runWithModelRetry)
      .mockResolvedValueOnce({ succeeded: false, error: new Error(LLAMA_SERVER_GRAMMAR_400) })
      .mockResolvedValueOnce({ succeeded: true });
    const first = makeDispatchParams(tools, "", "c-thrown-gate");
    (first.params.bridge.getResult as ReturnType<typeof vi.fn>).mockReturnValue({
      llmCalls: 1, stepsExecuted: 1, textEmitted: true, finishReason: "stop", lastLlmErrorMessage: undefined,
    });
    await runRetryLoop(first.params, "hello", undefined, false);

    // Second thrown grammar-400, SAME session: once-gate is closed — terminal,
    // but the promptError must carry the classified source (the thrown body),
    // not an empty string that classifies "unknown".
    vi.mocked(runWithModelRetry).mockReset();
    vi.mocked(runWithModelRetry).mockResolvedValue({
      succeeded: false,
      error: new Error(LLAMA_SERVER_GRAMMAR_400),
    });
    const second = makeDispatchParams(tools, "", "c-thrown-gate");
    (second.params.bridge.getResult as ReturnType<typeof vi.fn>).mockReturnValue({
      llmCalls: 1, stepsExecuted: 1, textEmitted: true, finishReason: "stop", lastLlmErrorMessage: undefined,
    });

    const outcome = await runRetryLoop(second.params, "hello", undefined, false);

    expect(vi.mocked(runWithModelRetry)).toHaveBeenCalledTimes(1);
    expect(outcome.promptSucceeded).toBe(false);
    expect(String(outcome.promptError)).toContain("JSON schema conversion failed");
  });

  it("WR-01: a non-grammar thrown failure stays terminal — no strip dispatch, no event (scope guard)", async () => {
    vi.mocked(runWithModelRetry).mockResolvedValue({
      succeeded: false,
      error: new Error("ECONNREFUSED connection refused"),
    });
    const { params, emit } = makeDispatchParams(makeHostileTools(), "", "c-thrown-other");

    const outcome = await runRetryLoop(params, "hello", undefined, false);

    expect(vi.mocked(runWithModelRetry)).toHaveBeenCalledTimes(1);
    expect(outcome.promptSucceeded).toBe(false);
    expect(emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure-path terminal diagnostics — knob-named timeout hints (LAT-01,
// Phase 177). processFailurePath is the all-models-failed surface: the retry
// loop returned promptSucceeded:false and emitFailureDiagnostics classifies
// the terminal error, logs the operator WARN, and writes the user-safe
// response. Pre-LAT-01 a PromptTimeoutError was logged with
// errorKind:"dependency", a generic hint, and finishReason:"error" — the
// operator learned WHAT (all models failed) but not WHICH KNOB.
// ---------------------------------------------------------------------------

describe("processFailurePath — knob-named timeout diagnostics (LAT-01-H-7)", () => {
  function makeFailureParams(channelId: string): {
    params: RunPromptParams;
    emit: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    result: ExecutionResult;
  } {
    const emit = vi.fn();
    const warn = vi.fn();
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
    };
    const result = {
      response: "",
      sessionKey: { tenantId: "t1", channelId, userId: "u1" },
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: { total: 0 },
      stepsExecuted: 0,
      llmCalls: 0,
      finishReason: "stop",
    } as unknown as ExecutionResult;
    const params = {
      msg: { channelId },
      session: { agent: { streamFn: vi.fn() } },
      sessionKey: { tenantId: "t1", channelId, userId: "u1" },
      agentId: "my-agent",
      executionId: "exec-lat01",
      executionStartMs: 0,
      result,
      mergedCustomTools: [],
      resolvedModel: { id: "qwen3.6:35b", provider: "my-ollama" },
      config: { provider: "my-ollama", model: "qwen3.6:35b", maxContextChars: 100_000 },
      effectiveTimeout: {
        promptTimeoutMs: 180_000,
        retryPromptTimeoutMs: 60_000,
        stallCeilingMultiplier: 10,
        source: "agent_config",
      },
      systemPrompt: undefined,
      onResetTimer: () => {},
      deps: {
        logger,
        eventBus: { emit },
        clock: { now: () => 195_000 },
        timers: {
          setTimeout: (fn: () => void) => {
            fn();
            return { cancelled: false, cancel: () => {}, unref: () => {} };
          },
        },
        modelRegistry: { find: vi.fn(() => undefined) },
      },
    } as unknown as RunPromptParams;
    return { params, emit, warn, result };
  }

  it("LAT-01-H-7: a terminal PromptTimeoutError carries errorKind 'timeout' + a knob-named hint on the WARN; finishReason 'prompt_timeout'; userMessage stays generic", async () => {
    const { params, warn, result } = makeFailureParams("c-lat01-timeout");
    const timeoutErr = new PromptTimeoutError(180_000, {
      limit: "stall",
      stallBudgetMs: 180_000,
    });

    await processFailurePath(params, "hello", undefined, timeoutErr);

    const warnCall = warn.mock.calls.find((c) => c[1] === "Prompt execution error");
    expect(warnCall).toBeDefined();
    expect(warnCall![0].errorKind).toBe("timeout");
    expect(warnCall![0].hint).toMatch(/promptTimeout\.promptTimeoutMs|operationModels/);
    expect(result.finishReason).toBe("prompt_timeout");
    // The knob detail NEVER leaks into the user reply (T-177-13): the response
    // is the byte-identical generic userMessage, with no config keys.
    expect(result.response).toBe(
      "The request took too long to process. Please try again with a simpler message.",
    );
    expect(result.response).not.toContain("agents.");
  });

  it("177-REVIEW IN-01: a terminal makespan kill renders the multiplier NUMBER in the hint — the binding carries stallCeilingMultiplier", async () => {
    const { params, warn } = makeFailureParams("c-in01-makespan");
    const makespanErr = new PromptTimeoutError(1_800_000, {
      limit: "makespan",
      stallBudgetMs: 180_000,
      makespanMs: 1_800_000,
    });

    await processFailurePath(params, "hello", undefined, makespanErr);

    const warnCall = warn.mock.calls.find((c) => c[1] === "Prompt execution error");
    expect(warnCall).toBeDefined();
    // Pre-patch the binding omitted stallCeilingMultiplier, so the makespan
    // hint rendered '(stall budget 180000 × stallCeilingMultiplier)' with no
    // multiplier value — number-less, despite EffectiveTimeout carrying the
    // non-optional field in scope.
    expect(warnCall![0].hint).toMatch(/stallCeilingMultiplier 10\)/);
    expect(warnCall![0].hint).toMatch(/makespan ceiling 1800000ms/);
  });

  it("177-REVIEW IN-04: the ghost-cost token_usage event reports the FIRED limit as latencyMs — a makespan kill is not understated by the multiplier", async () => {
    const { params, emit } = makeFailureParams("c-in04-ghost");
    const makespanErr = new PromptTimeoutError(1_800_000, {
      limit: "makespan",
      stallBudgetMs: 180_000,
      makespanMs: 1_800_000,
    });

    await processFailurePath(params, "hello", undefined, makespanErr);

    const usage = emit.mock.calls.find((c) => c[0] === "observability:token_usage");
    expect(usage).toBeDefined();
    // Pre-patch latencyMs hardcoded effectiveTimeout.promptTimeoutMs
    // (180_000) for every timeout — a makespan kill actually ran
    // ~promptTimeoutMs × stallCeilingMultiplier ms, understating by up to
    // the multiplier. PromptTimeoutError.timeoutMs carries the fired limit.
    expect((usage![1] as Record<string, unknown>).latencyMs).toBe(1_800_000);
  });

  it("LAT-01-H-7 regression: a non-timeout terminal error keeps finishReason 'error' + errorKind 'dependency' + the generic all-models hint", async () => {
    const { params, warn, result } = makeFailureParams("c-lat01-generic");

    await processFailurePath(params, "hello", undefined, new Error("ECONNREFUSED connection refused"));

    const warnCall = warn.mock.calls.find((c) => c[1] === "Prompt execution error");
    expect(warnCall).toBeDefined();
    expect(warnCall![0].errorKind).toBe("dependency");
    expect(warnCall![0].hint).toBe("All models failed (primary + fallbacks)");
    expect(result.finishReason).toBe("error");
  });
});
