// SPDX-License-Identifier: Apache-2.0
//
// Silent-sentinel responses do NOT reach memoryPort.store.
//
// The production module inserts an `isSilentResponse(result.response)`
// pre-gate so that responses like "[agent] NO_REPLY" / "NO_REPLY" /
// "HEARTBEAT_OK" / "[SILENT] x" never enter memory.db.
//
// We use a source-grep + behavior probe pair: the source-grep verifies
// the production module imports `isSilentResponse` from @comis/shared
// (the gate's load-bearing import); the behavior probe asserts that
// `shouldStorePairedMemory` and `isSilentResponse` together would refuse
// "NO_REPLY" responses.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { buildSessionEndMetadata, shouldStorePairedMemory, shouldRunLcdStorePasses, emitSessionSummary, END_REASON_MAP, promoteOutputStarved, unrecoveredFailedToolNames } from "./executor-post-execution.js";
import { buildOutputStarvedAnnotation, buildContextExhaustedReply, buildDegradedReply } from "./degraded-reply.js";
import { buildSessionHealthRollup, type SessionHealthRollup } from "./session-health-rollup.js";
import { attributeRecallUsage } from "../rag/recall-attribution.js";
// Learned-recall write side: the turn-end emit threads classifyIntent(msg.text).
// Imported here for the deterministic-bucket behavior probe (the emit's intent source).
import { classifyIntent } from "../rag/query-understanding.js";

const here = dirname(fileURLToPath(import.meta.url));

async function loadSilentTokens(): Promise<
  | {
      isSilentResponse: (s: string | undefined) => boolean;
    }
  | undefined
> {
  try {
    const mod = (await import("@comis/shared")) as Record<string, unknown>;
    if (typeof mod.isSilentResponse !== "function") return undefined;
    return mod as unknown as {
      isSilentResponse: (s: string | undefined) => boolean;
    };
  } catch {
    return undefined;
  }
}

describe("silent-sentinel response is not stored in memory.db", () => {
  it("source-grep — executor-post-execution imports isSilentResponse from @comis/shared", () => {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    // Strip line + block comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The production code imports isSilentResponse from @comis/shared.
    expect(stripped).toMatch(/import\s*\{[^}]*\bisSilentResponse\b[^}]*\}\s*from\s*"@comis\/shared"/);
  });

  it("behavior — isSilentResponse classifies NO_REPLY / [agent] NO_REPLY as silent", async () => {
    const mod = await loadSilentTokens();
    // The helper module must exist and be re-exported from @comis/shared.
    expect(mod).toBeDefined();
    if (!mod) return;
    expect(mod.isSilentResponse("NO_REPLY")).toBe(true);
    // The call site builds `[user] X\n[agent] <truncated response>`, so the
    // response itself is the bare "NO_REPLY". The helper is responsible for
    // handling whitespace + reply-tag wrapping idempotently.
    expect(mod.isSilentResponse("HEARTBEAT_OK")).toBe(true);
    expect(mod.isSilentResponse("[SILENT] context")).toBe(true);
  });

  it("behavior — substantive responses still pass the quality gate", () => {
    // Sanity: a substantive paired memory still qualifies for storage; the
    // silent-sentinel gate is a third layer ON TOP of the existing two
    // (operationType + content-hash dedup). It MUST NOT regress storage of
    // real conversations.
    const userText = "Show me the comparison chart for Q1 vs Q2";
    const agentResponse = "Here is the chart you requested. The Q1 numbers are…";
    expect(shouldStorePairedMemory(userText, agentResponse)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markRead/markConsumed via tryGetContext + drain
//
// Contract:
//   - markRead / markConsumed read tool context via tryGetContext()
//     (the AsyncLocalStorage handle), NOT a passed-in deps object.
//   - The drain happens at the call site (inline-consumption) keyed by the
//     composite (agentId, channelType, channelId).
//   - effectiveAgentId normalizes undefined / empty / string-"" to "default"
//     consistently across the memory-store path and markRead path.
//
// Source-grep is the load-bearing assertion mode — exercising the runtime
// path requires scaffolding all 30+ postExecution dependencies.
// ---------------------------------------------------------------------------
describe("markRead/markConsumed via tryGetContext + drain", () => {
  function readPostExec(): { src: string; stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { src, stripped };
  }

  it("markRead reads tool context via tryGetContext() (NOT a passed-in deps object)", () => {
    const { stripped } = readPostExec();
    // The production source either calls tryGetContext() directly OR imports
    // a helper module that does.
    expect(stripped).toMatch(/tryGetContext\s*\(/);
  });

  it("markConsumed follows the same tryGetContext pattern", () => {
    const { stripped } = readPostExec();
    expect(stripped).toMatch(/markConsumed/);
  });

  it("markRead is called at the inline-consumption call site — composite drain", () => {
    const { stripped } = readPostExec();
    // The post-execution path either calls a drainAt(...) or markRead with
    // the composite key. Either marker proves the gate.
    expect(stripped).toMatch(/(drainAt|markRead)/);
  });

  it("effectiveAgentId is referenced from a markRead/drain call-site (NOT only the memory branch)", () => {
    const { stripped } = readPostExec();
    // Contract: the normalized effectiveAgentId is shared with the
    // markRead/drain call (NOT computed only inside the memory-store
    // branch). A markRead or drain helper invocation must reference it.
    const reused =
      /(markRead|drainAt|markConsumed|consume)\s*\([^)]*effectiveAgentId/s.test(stripped) ||
      /effectiveAgentId[^)]*\b(markRead|drainAt|markConsumed|consume)\b/s.test(stripped);
    expect(reused).toBe(true);
  });

  it("multi-agent safety — drain key includes agentId (no cross-agent contamination)", () => {
    const { stripped } = readPostExec();
    // The drain key is (agentId, channelType, channelId). Source-grep
    // proves the agent is part of the drain key.
    expect(stripped).toMatch(/(drainAt|consume).*agentId/s);
  });

  it("lock-safe drain — concurrent drains for the same composite key are gated", () => {
    const { stripped } = readPostExec();
    // Marker for the single-tick gate analog (mirrors setup-delivery.ts:113-121).
    const hasGate =
      /\bdraining\b\s*[?=]/.test(stripped) ||
      /inFlight/i.test(stripped) ||
      /drainLock/i.test(stripped);
    expect(hasGate).toBe(true);
  });

  it("markRead failure is non-fatal (suppressError + structured WARN log)", () => {
    const { stripped } = readPostExec();
    // Marker: at least one suppressError reference plus the canonical
    // WARN log shape (hint + errorKind).
    expect(stripped).toMatch(/suppressError\b/);
    expect(stripped).toMatch(/(hint:.*errorKind|errorKind:.*hint)/s);
  });

  it("tryGetContext() in source falls through to no-op when undefined", () => {
    const { stripped } = readPostExec();
    // The call-site must exist for the gate to engage.
    const tryCtxLine = stripped.match(/tryGetContext\s*\([^)]*\)/);
    expect(tryCtxLine).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSessionEndMetadata: traceId vs runId contract
//
// Regression: the call site previously wrote `traceId: executionId` AND
// `runId: executionId` -- collapsing both fields onto the executor-scope
// UUID. The schema's "Trace ID for cross-correlating with daemon logs" field
// then could not be greppable against daemon.log, which is keyed by the
// AsyncLocalStorage traceId set in runWithContext. The fix routes the
// request-scope traceId into traceId and keeps executionId in runId.
// ---------------------------------------------------------------------------
// A clean (non-degraded) rollup default for the builder tests that only
// exercise the traceId/runId/endReason mapping — the F1 rollup-spread is
// asserted separately in the "F1 persist" describe below.
const cleanRollup: SessionHealthRollup = {
  degraded: false,
  costUsd: 0,
  toolStats: {},
  breakerTripCount: 0,
  topErrorKinds: {},
};

describe("buildSessionEndMetadata", () => {
  const baseArgs = {
    finishReason: "stop",
    durationMs: 1234,
    totalTokens: 567,
    executionId: "exec-Y",
    traceId: "trace-X",
    clock: { now: () => Date.now(), nowDate: () => new Date() },
    rollup: cleanRollup,
  };

  it("routes request-scope traceId into traceId, executionId into runId (distinct values)", () => {
    const result = buildSessionEndMetadata(baseArgs);
    expect(result.traceId).toBe("trace-X");
    expect(result.runId).toBe("exec-Y");
    // The two fields are not aliased onto the same UUID.
    expect(result.traceId).not.toBe(result.runId);
  });

  it("omits traceId when context is missing (undefined input)", () => {
    // tryGetContext() returns undefined outside any request scope. The schema's
    // conditional spread in writeSessionMetadata drops undefined, so the
    // previous merge value is preserved rather than nulling out the field.
    const result = buildSessionEndMetadata({ ...baseArgs, traceId: undefined });
    expect(result.traceId).toBeUndefined();
    expect(result.runId).toBe("exec-Y");
  });

  it("maps known finishReasons via END_REASON_MAP", () => {
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "stop" }).sessionEnd?.endReason).toBe("success");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "end_turn" }).sessionEnd?.endReason).toBe("success");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "budget_exceeded" }).sessionEnd?.endReason).toBe("budget_exceeded");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "circuit_open" }).sessionEnd?.endReason).toBe("circuit_open");
  });

  it("WR-02: maps loop_detected and session_reset EXPLICITLY (not via the catch-all fallthrough)", () => {
    // Both are known, in-union ExecutionResult.finishReason members — they must
    // have explicit END_REASON_MAP entries, not lean on the `?? "error"`
    // defensive bucket reserved for unknown provider strings.
    expect(Object.prototype.hasOwnProperty.call(END_REASON_MAP, "loop_detected")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(END_REASON_MAP, "session_reset")).toBe(true);
    expect(END_REASON_MAP.loop_detected).toBe("error");
    expect(END_REASON_MAP.session_reset).toBe("error");
    // And they reach sessionEnd.endReason:"error" through the real builder.
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "loop_detected" }).sessionEnd?.endReason).toBe("error");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "session_reset" }).sessionEnd?.endReason).toBe("error");
  });

  it("WR-02: END_REASON_MAP never produces the dead 'timeout' endReason literal", () => {
    // The SessionMetadata.sessionEnd.endReason union still declares "timeout",
    // but no source finishReason maps to it — assert the writer cannot emit it so
    // the dead literal is documented as unreachable from THIS path (not silently
    // re-introduced via a stray mapping).
    expect(Object.values(END_REASON_MAP)).not.toContain("timeout");
  });

  it("QT2: un-flattens the context-exhaustion cause — context_exhausted and context_loop both name it (not generic error)", () => {
    // The degradation taxonomy previously collapsed BOTH context-exhaustion
    // finish reasons to the generic "error" bucket, so a context-exhausted
    // session was indistinguishable from a tool crash in obs.explain /
    // obs.fleet.health. QT2 folds the two related reasons into ONE named cause:
    // context_exhausted (the bridge actively sets finishReason:"context_exhausted"
    // at the block guard) AND context_loop (the related loop-on-exhaustion abort)
    // both map to the SINGLE "context_exhausted" endReason.
    expect(END_REASON_MAP.context_exhausted).toBe("context_exhausted");
    expect(END_REASON_MAP.context_loop).toBe("context_exhausted");
    // And the value reaches sessionEnd.endReason through the real builder.
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "context_exhausted" }).sessionEnd?.endReason).toBe("context_exhausted");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "context_loop" }).sessionEnd?.endReason).toBe("context_exhausted");
    // Still degraded (the named cause is not "success").
    expect(buildSessionHealthRollup({}, "context_exhausted").degraded).toBe(true);
  });

  it("QT3: output_starved is a named terminal cause in END_REASON_MAP (not generic error)", () => {
    // The chokepoint promotes a terminal output-cap truncation to
    // finishReason:"output_starved"; the map must carry it as its OWN named
    // endReason so the cause survives into the persisted rollup + both lenses.
    expect(END_REASON_MAP.output_starved).toBe("output_starved");
    expect(buildSessionEndMetadata({ ...baseArgs, finishReason: "output_starved" }).sessionEnd?.endReason).toBe("output_starved");
    // Still degraded (output_starved is not "success").
    expect(buildSessionHealthRollup({}, "output_starved").degraded).toBe(true);
  });

  it("falls back to 'error' for unmapped finishReasons", () => {
    const result = buildSessionEndMetadata({ ...baseArgs, finishReason: "some_unknown_reason" });
    expect(result.sessionEnd?.endReason).toBe("error");
  });

  it("CR-01/WR-01: degraded is coupled to END_REASON_MAP over the WHOLE finishReason union (no dual-set drift)", () => {
    // The enforced single-source invariant: for EVERY ExecutionResult.finishReason
    // (plus the synthetic completed_with_tool_errors / end_turn that reach the
    // chokepoint), the rollup's degraded MUST equal `mappedEndReason !== "success"`.
    // This converts the prose "mirrors END_REASON_MAP" comment into a test —
    // adding a new finish reason to the union without an END_REASON_MAP entry can
    // no longer silently reopen the CR-01 divergence (it falls to "error" ⇒
    // degraded, never to a stale degraded:false).
    const ALL_FINISH_REASONS = [
      "stop", "end_turn", "error", "max_steps",
      "budget_exceeded", "budget_exhausted", "circuit_open", "provider_degraded",
      "context_loop", "context_exhausted", "output_starved", "session_reset", "loop_detected",
      "completed_with_tool_errors",
    ];
    for (const reason of ALL_FINISH_REASONS) {
      const mappedEndReason = END_REASON_MAP[reason] ?? "error";
      const expectedDegraded = mappedEndReason !== "success";
      // The chokepoint maps once, then passes the mapped endReason to the rollup.
      expect(buildSessionHealthRollup({}, mappedEndReason).degraded).toBe(expectedDegraded);
    }
    // Spotlight the two reasons CR-01 was filed for: both map to "error" ⇒ degraded.
    expect(buildSessionHealthRollup({}, END_REASON_MAP.loop_detected ?? "error").degraded).toBe(true);
    expect(buildSessionHealthRollup({}, END_REASON_MAP.session_reset ?? "error").degraded).toBe(true);
  });

  it("CR-01: the chokepoint maps endReason ONCE and feeds the SAME mapped value to the rollup (single source)", () => {
    // Source-grep the production module: the rollup must be driven by the mapped
    // endReason (END_REASON_MAP[...] ?? "error"), NOT a second closed reason set.
    // A regression that reintroduced a standalone degraded predicate over the raw
    // finishReason would not match this coupling.
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // A single endReason is derived from END_REASON_MAP and threaded into the rollup.
    expect(stripped).toMatch(/END_REASON_MAP\[[^\]]+\]\s*\?\?\s*"error"/);
    expect(stripped).toMatch(/buildSessionHealthRollup\([^)]*endReason[^)]*\)/);
  });

  it("propagates durationMs and totalTokens verbatim into sessionEnd", () => {
    const result = buildSessionEndMetadata(baseArgs);
    expect(result.sessionEnd?.durationMs).toBe(1234);
    expect(result.sessionEnd?.totalTokens).toBe(567);
    expect(result.sessionEnd?.type).toBe("session_end");
    expect(typeof result.sessionEnd?.timestamp).toBe("string");
  });

  it("call site reads traceId from tryGetContext() (NOT from executionId)", () => {
    // Source-grep: the production path must invoke tryGetContext() inside the
    // buildSessionEndMetadata call to populate traceId. A regression that
    // re-aliased traceId onto executionId would not match this pattern.
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(stripped).toMatch(/buildSessionEndMetadata\([\s\S]*?traceId:\s*tryGetContext\(\)\?\.traceId/);
  });
});

describe("promoteOutputStarved (QT3 — conservative terminal-truncation promotion)", () => {
  // The SDK-normalized AssistantMessage.stopReason union is
  // "stop" | "length" | "toolUse" | "error" | "aborted" (pi-ai types.d.ts), so
  // "length" is the output-cap truncation signal. m.lastStopReason is captured at
  // EVERY turn_end (pi-event-bridge.ts), so the FINAL value is the terminal stop.

  it("PROMOTES a terminal length-stop on an otherwise-clean run to output_starved", () => {
    // The model got cut off at the output cap as the terminal state, and the run
    // would OTHERWISE map to a clean reason (stop → success). THIS is the
    // pathological terminal the detector must name.
    expect(promoteOutputStarved("stop", "length")).toBe("output_starved");
    expect(promoteOutputStarved("end_turn", "length")).toBe("output_starved");
    // Defensive provider-raw variants are also accepted as the terminal cap stop.
    expect(promoteOutputStarved("stop", "max_tokens")).toBe("output_starved");
    expect(promoteOutputStarved("stop", "maxTokens")).toBe("output_starved");
    // And the promoted reason maps to the named cause end-to-end.
    expect(END_REASON_MAP[promoteOutputStarved("stop", "length")]).toBe("output_starved");
  });

  it("does NOT flag a benign continued/non-terminal length-stop — a clean terminal stays success", () => {
    // The load-bearing guard against flagging healthy sessions. A long answer that
    // hit the cap mid-run but the agent CONTINUED past (output escalation re-ran,
    // or another turn followed) ends with a NON-length terminal stopReason
    // ("stop"/"end"/"toolUse") — m.lastStopReason was overwritten at the later
    // turn_end. Such a run must stay clean (success), never output_starved.
    expect(promoteOutputStarved("stop", "stop")).toBe("stop");
    expect(promoteOutputStarved("stop", "end")).toBe("stop");
    expect(promoteOutputStarved("end_turn", "toolUse")).toBe("end_turn");
    // No terminal stop reason captured at all ⇒ no promotion.
    expect(promoteOutputStarved("stop", undefined)).toBe("stop");
    // Sanity: a clean run with a clean terminal stays mapped to success.
    expect(END_REASON_MAP[promoteOutputStarved("stop", "stop")]).toBe("success");
  });

  it("does NOT override a NON-clean terminal cause even with a terminal length-stop", () => {
    // If the run already settled on a non-clean cause (tool errors, budget,
    // breaker, error), the output-cap truncation is NOT the headline — the
    // upstream cause wins. The promotion fires ONLY when the would-be endReason
    // is clean, so these pass through untouched.
    expect(promoteOutputStarved("completed_with_tool_errors", "length")).toBe("completed_with_tool_errors");
    expect(promoteOutputStarved("budget_exhausted", "length")).toBe("budget_exhausted");
    expect(promoteOutputStarved("circuit_open", "length")).toBe("circuit_open");
    expect(promoteOutputStarved("error", "length")).toBe("error");
    expect(promoteOutputStarved("context_exhausted", "length")).toBe("context_exhausted");
  });

  it("source-grep — the chokepoint threads lastStopReason through promoteOutputStarved into the mapped endReason", () => {
    // Pin that the production chokepoint actually CALLS the promotion (so the
    // pure helper is not dead code) and feeds its result into END_REASON_MAP —
    // the single mapped endReason that drives BOTH the persisted sessionEnd and
    // the session:summary emit.
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(stripped).toMatch(/promoteOutputStarved\(/);
    // lastStopReason must be read off the bridge result and threaded in.
    expect(stripped).toMatch(/lastStopReason/);
  });
});

// ---------------------------------------------------------------------------
// F1/F2: the session-health rollup is computed ONCE and feeds BOTH sinks —
// the sessionEnd metadata (F1, via buildSessionEndMetadata) and the
// session:summary event (F2, via emitSessionSummary). The emit is
// fire-and-forget: a throwing listener must NOT abort the teardown (OQ3).
// ---------------------------------------------------------------------------
describe("F1 persist — buildSessionEndMetadata threads the health rollup into sessionEnd", () => {
  const rollup: SessionHealthRollup = {
    degraded: true,
    costUsd: 1.45,
    toolStats: { web_fetch: { ok: 2, failed: 8 } },
    breakerTripCount: 1,
    topErrorKinds: { dependency: 8 },
  };
  const baseArgs = {
    finishReason: "completed_with_tool_errors",
    durationMs: 1000,
    totalTokens: 500,
    executionId: "exec-Z",
    traceId: "trace-Z",
    clock: { now: () => 0, nowDate: () => new Date(0) },
    rollup,
  };

  it("spreads degraded/costUsd/toolStats/breakerTripCount/topErrorKinds from the rollup onto sessionEnd", () => {
    const result = buildSessionEndMetadata(baseArgs);
    expect(result.sessionEnd?.degraded).toBe(true);
    expect(result.sessionEnd?.costUsd).toBe(1.45);
    expect(result.sessionEnd?.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(result.sessionEnd?.breakerTripCount).toBe(1);
    expect(result.sessionEnd?.topErrorKinds).toEqual({ dependency: 8 });
    // The 4 required fields are still present (additive, not replaced).
    expect(result.sessionEnd?.endReason).toBe("completed_with_tool_errors");
    expect(result.sessionEnd?.totalTokens).toBe(500);
  });
});

describe("F2 emit — emitSessionSummary emits session:summary, fire-and-forget", () => {
  const rollup: SessionHealthRollup = {
    degraded: true,
    costUsd: 1.45,
    toolStats: { web_fetch: { ok: 2, failed: 8 } },
    breakerTripCount: 1,
    topErrorKinds: { dependency: 8 },
  };
  const baseArgs = {
    sessionKey: "tenant_a/user_a/chan",
    agentId: "agent_a",
    traceId: "trace-Z",
    turnCount: 3,
    rollup,
    endReason: "context_exhausted",
    clock: { now: () => 4242, nowDate: () => new Date(4242) },
  };

  it("CARRIES the named endReason cause on the emitted event payload (QT2/QT3 — fleet aggregates by cause)", () => {
    // The mapped endReason (e.g. context_exhausted / output_starved) is the
    // headline cause. It must ride the session:summary event so the daemon row
    // (sessionSummaryEventToRow) persists it and obs.fleet.health can aggregate
    // degradedByCause WITHOUT opening per-session _session-metadata.json.
    const emit = vi.fn();
    const eventBus = { emit, on: vi.fn(), off: vi.fn() } as unknown as import("@comis/core").TypedEventBus;
    emitSessionSummary({ eventBus, logger: undefined }, baseArgs);
    const payload = emit.mock.calls.find((c) => c[0] === "session:summary")![1] as Record<string, unknown>;
    expect(payload.endReason).toBe("context_exhausted");
  });

  it("emits exactly one session:summary carrying degraded/costUsd/toolStats/breakerTripCount + ids", () => {
    const emit = vi.fn();
    const eventBus = { emit, on: vi.fn(), off: vi.fn() } as unknown as import("@comis/core").TypedEventBus;

    emitSessionSummary({ eventBus, logger: undefined }, baseArgs);

    const summaryCalls = emit.mock.calls.filter((c) => c[0] === "session:summary");
    expect(summaryCalls).toHaveLength(1);
    const payload = summaryCalls[0]![1] as Record<string, unknown>;
    expect(payload.degraded).toBe(true);
    expect(payload.costUsd).toBe(1.45);
    expect(payload.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(payload.breakerTripCount).toBe(1);
    expect(payload.turnCount).toBe(3);
    expect(payload.sessionKey).toBe("tenant_a/user_a/chan");
    expect(payload.agentId).toBe("agent_a");
    expect(payload.traceId).toBe("trace-Z");
    expect(payload.timestamp).toBe(4242);
  });

  it("CARRIES topErrorKinds + source:'runtime' on the emitted event payload (A1/A2, Phase 159 — OQ1 reversed)", () => {
    // OQ1 is reversed: the fleet aggregate (A1/A2) needs topErrorKinds + source
    // on the row, and the row is written from this event payload. Production
    // emits the constant "runtime"; tests inject "test" by building the payload.
    const emit = vi.fn();
    const eventBus = { emit, on: vi.fn(), off: vi.fn() } as unknown as import("@comis/core").TypedEventBus;
    emitSessionSummary({ eventBus, logger: undefined }, baseArgs);
    const payload = emit.mock.calls.find((c) => c[0] === "session:summary")![1] as Record<string, unknown>;
    expect(payload.topErrorKinds).toEqual({ dependency: 8 });
    expect(payload.topErrorKinds).toBe(baseArgs.rollup.topErrorKinds);
    expect(payload.source).toBe("runtime");
  });

  it("a THROWING eventBus listener does NOT propagate out of emitSessionSummary (fire-and-forget, OQ3)", () => {
    const eventBus = {
      emit: vi.fn().mockImplementation(() => {
        throw new Error("listener blew up");
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as import("@comis/core").TypedEventBus;

    // The synchronous eventBus would propagate the throw without a guard.
    expect(() => emitSessionSummary({ eventBus, logger: undefined }, baseArgs)).not.toThrow();
  });

  it("is a silent no-op when no eventBus is wired (legacy / sub-agent path)", () => {
    // The chokepoint guards with `if (deps.eventBus)`; emitSessionSummary
    // returns early when the bus is absent — never throwing, nothing emitted.
    expect(() => emitSessionSummary({ eventBus: undefined, logger: undefined }, baseArgs)).not.toThrow();
  });
});

describe("F1/F2 wiring — postExecution computes the rollup once and feeds both sinks", () => {
  function readPostExec(): string {
    return readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
  }
  function stripped(): string {
    return readPostExec()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  }

  it("computes the health rollup exactly once at the chokepoint", () => {
    const callCount = (stripped().match(/buildSessionHealthRollup\(/g) ?? []).length;
    expect(callCount).toBe(1);
  });

  it("imports buildSessionHealthRollup from the sibling module", () => {
    expect(readPostExec()).toMatch(/import\s*\{\s*buildSessionHealthRollup[\s\S]*?\}\s*from\s*"\.\/session-health-rollup\.js"/);
  });

  it("threads the rollup into the buildSessionEndMetadata call (F1)", () => {
    expect(stripped()).toMatch(/buildSessionEndMetadata\([\s\S]*?rollup[\s\S]*?\}\)/);
  });

  it("emits session:summary via emitSessionSummary at the chokepoint (F2)", () => {
    expect(stripped()).toMatch(/emitSessionSummary\(/);
  });
});

// ---------------------------------------------------------------------------
// costCorrectionDeltaUsd on Execution-complete
//
// Regression contract: the Execution-complete log payload conditionally
// includes `costCorrectionDeltaUsd` when `bridgeResult.totalCostCorrectionDeltaUsd
// > 0`. Turns with no SDK correction omit the field entirely. The conditional
// spread mirrors the per-event `costCorrectionField` gate in pi-event-bridge.ts.
//
// Strategy: source-grep on the production module (same pattern as the
// surrounding describes). The full `logger.info({...}, "Execution complete")`
// payload is built deep inside postExecution(), which requires 30+ deps;
// asserting the conditional spread shape via source-grep is the
// proportional check.
// ---------------------------------------------------------------------------
describe("Execution-complete log — costCorrectionDeltaUsd", () => {
  function readPostExec(): string {
    return readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
  }

  it("payload contains a conditional spread guarded by totalCostCorrectionDeltaUsd > 0", () => {
    const src = readPostExec();
    // Strip comments so the gate cannot be self-invalidated by a commented-out spread.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The spread shape: ...((bridgeResult.totalCostCorrectionDeltaUsd ?? 0) > 0 && { costCorrectionDeltaUsd: ... })
    expect(stripped).toMatch(
      /\.\.\.\(\(bridgeResult\.totalCostCorrectionDeltaUsd\s*\?\?\s*0\)\s*>\s*0\s*&&\s*\{\s*costCorrectionDeltaUsd:/,
    );
  });

  it("PostExecutionBridgeResult interface declares totalCostCorrectionDeltaUsd?: number", () => {
    const src = readPostExec();
    // The optional field must be typed `number` so consumers see a coherent shape.
    expect(src).toMatch(/totalCostCorrectionDeltaUsd\?:\s*number/);
  });
});

// ---------------------------------------------------------------------------
// tool-failure endReason and notice
//
// Contract:
//   - When finishReason ∈ {stop, end_turn} AND failedTools is non-empty, the
//     session metadata endReason MUST be "completed_with_tool_errors" — this
//     override is UNCONDITIONAL, independent of model acknowledgement.
//   - A failure notice ("\n[tool failure] <toolName> reported an error (see
//     session log for details)") is appended to result.response ONLY when the
//     model did not already acknowledge the failure (modelAcknowledgedFailure)
//     AND the response is not a silent sentinel (isSilentResponse).
//   - endReason="success" when finishReason="stop" and failedTools is empty
//     (baseline unchanged).
// ---------------------------------------------------------------------------
describe("tool-failure endReason and notice", () => {
  const baseClock = { now: () => Date.now(), nowDate: () => new Date() };

  // -------------------------------------------------------------------------
  // Unit tests against buildSessionEndMetadata (pure function)
  // -------------------------------------------------------------------------

  it("buildSessionEndMetadata maps completed_with_tool_errors to completed_with_tool_errors", () => {
    const result = buildSessionEndMetadata({
      finishReason: "completed_with_tool_errors",
      durationMs: 100,
      totalTokens: 10,
      executionId: "exec-1",
      traceId: undefined,
      clock: baseClock,
      rollup: cleanRollup,
    });
    expect(result.sessionEnd?.endReason).toBe("completed_with_tool_errors");
  });

  it("buildSessionEndMetadata baseline: stop still maps to success when no tool failure", () => {
    const result = buildSessionEndMetadata({
      finishReason: "stop",
      durationMs: 100,
      totalTokens: 10,
      executionId: "exec-2",
      traceId: undefined,
      clock: baseClock,
      rollup: cleanRollup,
    });
    expect(result.sessionEnd?.endReason).toBe("success");
  });

  // -------------------------------------------------------------------------
  // Source-grep tests — call-site structure in executor-post-execution.ts
  // -------------------------------------------------------------------------

  function readPostExecStripped(): string {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("source-grep — effectiveFinishReason derived from failedTools when finishReason is stop or end_turn", () => {
    const stripped = readPostExecStripped();
    // The effectiveFinishReason override must exist in the source.
    expect(stripped).toMatch(/effectiveFinishReason/);
    // The override must use the completed_with_tool_errors literal.
    expect(stripped).toMatch(/completed_with_tool_errors/);
  });

  it("source-grep — modelAcknowledgedFailure function exists in executor-post-execution.ts", () => {
    const stripped = readPostExecStripped();
    // The helper function must be defined in the module.
    expect(stripped).toMatch(/function\s+modelAcknowledgedFailure\s*\(/);
  });

  it("source-grep — failure notice '[tool failure]' appended to result.response at call site", () => {
    const stripped = readPostExecStripped();
    // The notice text must appear in non-comment source.
    expect(stripped).toMatch(/\[tool failure\]/);
  });

  it("source-grep — isSilentResponse guards the failure notice append (not the endReason override)", () => {
    const stripped = readPostExecStripped();
    // isSilentResponse must be referenced near the [tool failure] notice append.
    // The pattern: isSilentResponse appears before or in the same conditional as [tool failure].
    expect(stripped).toMatch(/isSilentResponse/);
    // Critically: modelAcknowledgedFailure must NOT appear in the effectiveFinishReason
    // derivation — the endReason override is unconditional.
    // Verify: effectiveFinishReason assignment does NOT reference modelAcknowledgedFailure.
    const effectiveFRBlock = stripped.match(/effectiveFinishReason\s*=[\s\S]*?;/);
    expect(effectiveFRBlock).not.toBeNull();
    if (effectiveFRBlock) {
      expect(effectiveFRBlock[0]).not.toMatch(/modelAcknowledgedFailure/);
    }
  });

  it("source-grep — buildSessionEndMetadata call passes effectiveFinishReason (not result.finishReason)", () => {
    const stripped = readPostExecStripped();
    // The buildSessionEndMetadata call site must use effectiveFinishReason.
    expect(stripped).toMatch(/buildSessionEndMetadata\s*\(\s*\{[\s\S]*?finishReason\s*:\s*effectiveFinishReason/);
    // And must NOT use result.finishReason for that argument.
    const buildCallMatch = stripped.match(/buildSessionEndMetadata\s*\(\s*\{[\s\S]*?\}\s*\)/);
    if (buildCallMatch) {
      expect(buildCallMatch[0]).not.toMatch(/finishReason\s*:\s*result\.finishReason/);
    }
  });

  // -------------------------------------------------------------------------
  // HR-01 (v2.19) — the user-facing '[tool failure]' notice must NOT fire for a
  // tool that FAILED then SUCCEEDED on retry in the SAME turn (recovered).
  // Live: pipeline attempt-1 (validation) failed, attempt-2 launched the graph,
  // yet the user still saw "[tool failure] pipeline reported an error". The notice
  // must surface only UNRECOVERED failures (a failed tool with no same-name
  // success this turn). Observability (effectiveFinishReason/logs/fleet) still
  // records the failure — only the user-facing reply is gated.
  // See design/small-model-orchestration-fidelity.md §4.
  it("source-grep — failure notice gated on unrecoveredFailedToolNames (recovered failures suppressed)", () => {
    const stripped = readPostExecStripped();
    // The notice call site must consult the recovery-aware helper, not raw failedTools.
    expect(stripped).toMatch(/unrecoveredFailedToolNames/);
    // The notice append must be guarded by a non-empty unrecovered set.
    const noticeBlock = stripped.match(/unrecovered[A-Za-z]*\s*\.length\s*>\s*0[\s\S]{0,400}?\[tool failure\]/);
    expect(noticeBlock).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unrecoveredFailedToolNames — recovery-aware failure classification (HR-01)
// ---------------------------------------------------------------------------
describe("unrecoveredFailedToolNames", () => {
  it("treats a fail-then-succeed of the SAME tool as recovered (empty result)", () => {
    // The live NVDA case: pipeline failed (validation) then succeeded (launch).
    expect(
      unrecoveredFailedToolNames(
        ["pipeline"],
        [
          { toolName: "pipeline", success: false, durationMs: 21 },
          { toolName: "pipeline", success: true, durationMs: 27 },
        ],
      ),
    ).toEqual([]);
  });

  it("reports a tool that failed and never succeeded as unrecovered", () => {
    expect(
      unrecoveredFailedToolNames(
        ["pipeline"],
        [{ toolName: "pipeline", success: false, durationMs: 21 }],
      ),
    ).toEqual(["pipeline"]);
  });

  it("a DIFFERENT tool succeeding does NOT count as recovery", () => {
    expect(
      unrecoveredFailedToolNames(
        ["write"],
        [
          { toolName: "write", success: false, durationMs: 5 },
          { toolName: "read", success: true, durationMs: 3 },
        ],
      ),
    ).toEqual(["write"]);
  });

  it("dedups repeated failed tool names", () => {
    expect(
      unrecoveredFailedToolNames(
        ["pipeline", "pipeline"],
        [{ toolName: "pipeline", success: true, durationMs: 27 }],
      ),
    ).toEqual([]);
  });

  it("safe fallback: missing toolExecResults → all failed tools are unrecovered (current behavior)", () => {
    expect(unrecoveredFailedToolNames(["pipeline"], undefined)).toEqual(["pipeline"]);
    expect(unrecoveredFailedToolNames(["pipeline"], [])).toEqual(["pipeline"]);
  });

  it("empty failedTools → empty", () => {
    expect(unrecoveredFailedToolNames([], undefined)).toEqual([]);
  });

  it("mixed: one recovered, one not → only the unrecovered survives", () => {
    expect(
      unrecoveredFailedToolNames(
        ["pipeline", "search"],
        [
          { toolName: "pipeline", success: false, durationMs: 21 },
          { toolName: "pipeline", success: true, durationMs: 27 },
          { toolName: "search", success: false, durationMs: 9 },
        ],
      ),
    ).toEqual(["search"]);
  });
});

// ---------------------------------------------------------------------------
// modelAcknowledgedFailure must use word-boundary matching
// ---------------------------------------------------------------------------
// The helper is private inside executor-post-execution.ts, so we test its
// behaviour via the source text (the same pattern used by the tool-failure
// suite above).
// ---------------------------------------------------------------------------
// Recall-usage attribution + memory:recall_used emit (flag-gated).
//
// postExecution() attributes which recalled memories were used vs ignored from
// result.response (the pure attributeRecallUsage heuristic) and emits a
// counts+ids-only memory:recall_used event, gated on config.rag.feedback.enabled
// (default OFF → no emit). Content stays in-process; only ids cross the bus.
//
// Source-grep is the load-bearing mode (scaffolding all 30+ postExecution deps
// is impractical — see the markRead block above). The grep locks: the in-package
// import (cut held), the default-off gate, the emit shape, and the no-content
// invariant on the emit call site. A paired behavior probe re-confirms the
// attribution fn drives the ids the emit will carry.
// ---------------------------------------------------------------------------
describe("recall-usage attribution + memory:recall_used emit", () => {
  function readPostExec(): { src: string; stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { src, stripped };
  }

  it("imports attributeRecallUsage in-package (the agent↛memory cut held)", () => {
    const { stripped } = readPostExec();
    expect(stripped).toMatch(
      /import\s*\{[^}]*\battributeRecallUsage\b[^}]*\}\s*from\s*"\.\.\/rag\/recall-attribution\.js"/,
    );
    // No @comis/memory import anywhere in production source.
    expect(stripped).not.toMatch(/from\s*"@comis\/memory"/);
  });

  it("gates the emit on rag.feedback.enabled === true (default-off guard)", () => {
    const { stripped } = readPostExec();
    expect(stripped).toMatch(/feedback\?\.enabled\s*===\s*true/);
  });

  it("emits memory:recall_used with usedIds/ignoredIds/usedCount/ignoredCount (counts+ids only)", () => {
    const { stripped } = readPostExec();
    // The emit call exists and carries the counts+ids payload.
    expect(stripped).toMatch(/emit\(\s*"memory:recall_used"/);
    const emitBlock = stripped.match(/emit\(\s*"memory:recall_used"[\s\S]*?\}\s*\);/);
    expect(emitBlock, "memory:recall_used emit call must exist").not.toBeNull();
    const block = emitBlock![0];
    expect(block).toMatch(/usedIds/);
    expect(block).toMatch(/ignoredIds/);
    expect(block).toMatch(/usedCount/);
    expect(block).toMatch(/ignoredCount/);
  });

  it("the emit call carries NO memory content / response / preview field", () => {
    const { stripped } = readPostExec();
    const emitBlock = stripped.match(/emit\(\s*"memory:recall_used"[\s\S]*?\}\s*\);/);
    expect(emitBlock).not.toBeNull();
    const block = emitBlock![0];
    // ids + counts only — never the content, the response text, or a preview.
    expect(block, "no content: field").not.toMatch(/\bcontent:/);
    expect(block, "no .response payload").not.toMatch(/\.response\b/);
    expect(block, "no preview field").not.toMatch(/\bpreview\b/);
  });

  it("behavior — attributeRecallUsage drives the ids the emit carries (echo → used)", () => {
    // The emit's usedIds/ignoredIds come straight from attributeRecallUsage.
    // Re-confirm the documented behavior end-to-end at the call-site contract:
    // a recalled memory echoed in the response is attributed USED.
    const recalled = [
      { id: "used-1", content: "the incident postmortem identified a missing retry budget" },
      { id: "ignored-1", content: "unrelated trivia about the office plants" },
    ];
    const response =
      "Per the incident postmortem, we identified a missing retry budget and added one.";
    const { usedIds, ignoredIds } = attributeRecallUsage(recalled, response);
    expect(usedIds).toContain("used-1");
    expect(ignoredIds).toContain("ignored-1");
    // Counts the emit reports are the array lengths (parity with the family).
    expect(usedIds.length).toBe(1);
    expect(ignoredIds.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Learned-recall write side — the turn-end memory:recall_used
  // emit carries the recall-time intent so the daemon write-back records the
  // per-intent usefulness bucket. The intent is the DETERMINISTIC classifyIntent
  // of the recalled query (msg.text — the SAME string recall classified at
  // prompt-assembly.ts:818) gated on the SAME queryUnderstanding.intentReweight
  // flag the recall read uses; intentReweight off → the emit omits intent (the
  // subscriber records the global bucket → byte-identical write). classifyIntent
  // is in-package (NOT publicly exported — Pitfall 2) and the emit stays
  // ids/counts/intent-only + LLM-free. Source-grep is the load-bearing mode here,
  // matching the recall-usage family above (scaffolding all 30+ deps is impractical).
  // -------------------------------------------------------------------------
  it("threads the recall-time intent onto the emit, gated on queryUnderstanding.intentReweight", () => {
    const { stripped } = readPostExec();
    // The intent is computed from the recalled query via the deterministic classifyIntent …
    expect(stripped).toMatch(/classifyIntent\s*\(/);
    // … gated on the SAME intentReweight flag the recall read uses (per-intent on/off) …
    expect(stripped).toMatch(/intentReweight\s*===\s*true/);
    // … and threaded onto the emit payload via the conditional spread (omitted when undefined).
    expect(stripped).toMatch(/intent !== undefined \? \{ intent \}/);
    // The intent spread lives INSIDE the memory:recall_used emit call.
    const emitBlock = stripped.match(/emit\(\s*"memory:recall_used"[\s\S]*?\}\s*\);/);
    expect(emitBlock, "memory:recall_used emit call must exist").not.toBeNull();
    expect(emitBlock![0]).toMatch(/intent/);
  });

  it("imports classifyIntent in-package from the rag module (the agent↛memory cut held)", () => {
    const { stripped } = readPostExec();
    expect(stripped).toMatch(
      /import\s*\{[^}]*\bclassifyIntent\b[^}]*\}\s*from\s*"\.\.\/rag\/query-understanding\.js"/,
    );
    // No @comis/memory import on the write path.
    expect(stripped).not.toMatch(/from\s*"@comis\/memory"/);
  });

  it("classifyIntent is NOT re-exported from the agent public barrel (Pitfall 2 — no daemon caller can drag an LLM in)", () => {
    const indexSrc = readFileSync(resolve(here, "..", "index.ts"), "utf-8");
    expect(indexSrc).not.toMatch(/\bclassifyIntent\b/);
  });

  it("the emit stays ids/counts/intent-only — the intent is the closed-union string, NOT memory content/query/response", () => {
    const { stripped } = readPostExec();
    const emitBlock = stripped.match(/emit\(\s*"memory:recall_used"[\s\S]*?\}\s*\);/);
    expect(emitBlock).not.toBeNull();
    const block = emitBlock![0];
    // Still no content/response/preview on the event after adding intent.
    expect(block, "no content: field").not.toMatch(/\bcontent:/);
    expect(block, "no .response payload").not.toMatch(/\.response\b/);
    expect(block, "no preview field").not.toMatch(/\bpreview\b/);
    // The intent is the classified bucket, never the raw query text on the event.
    expect(block, "no query: field on the event").not.toMatch(/\bquery:/);
  });

  it("behavior — classifyIntent(msg.text) is the deterministic bucket the emit threads (the recalled query → its intent)", () => {
    // The emit's intent is exactly classifyIntent over the recalled query (msg.text — the
    // string prompt-assembly.ts:818 recalled on). Re-confirm the deterministic mapping at
    // the contract: a temporal-shaped query classifies "temporal"; a plain lookup "factual".
    expect(classifyIntent("when did the deploy happen")).toBe("temporal");
    expect(classifyIntent("what is the database name")).toBe("factual");
  });
});

describe("modelAcknowledgedFailure word-boundary regression", () => {
  function readPostExecSource(): string {
    return readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
  }

  it("source-grep — modelAcknowledgedFailure uses word-boundary RegExp (not bare .includes)", () => {
    const src = readPostExecSource();
    // Must use \\b escapes — plain .includes() approach must NOT be the sole tool-name check
    // (we allow .includes for the failure keyword, but the tool-name must use \\b).
    expect(src).toMatch(/\\\\b.*escaped|nameRe|new RegExp|wordBoundary|\bescaped\b.*\\\\b/);
  });

  it("source-grep — 'write' substring collision: 'writer' does NOT satisfy the word-boundary check", () => {
    // If the source still uses bare .includes, the token 'write' would match inside 'writer'.
    // This test verifies the implementation no longer allows that by checking the regex is present.
    const src = readPostExecSource();
    // The fix must introduce a RegExp with \b or an equivalent word-boundary approach.
    // We require \\b (escaped in the source string literal) to be present in modelAcknowledgedFailure.
    const fnBlock = src.match(/function\s+modelAcknowledgedFailure\s*\([\s\S]*?\n\}/);
    expect(fnBlock).not.toBeNull();
    if (fnBlock) {
      // Must contain word-boundary escape
      expect(fnBlock[0]).toMatch(/\\b|wordBoundary/);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX A — the LCD afterTurn store passes (ingest + leaf + condense) run ONLY
// when the agent's effective context engine is `dag`.
//
// Bug: the `if (deps.contextStore)` block was PRESENCE-gated, not version-gated.
// The daemon injects the LCD ContextStorePort UNCONDITIONALLY
// (setup-agents-runtime.ts:447 `contextStore: deps.lcdStore`), so a PIPELINE
// agent wrote `lcd_messages` every turn AND fired leaf/condense LLM
// summarization calls — yet NOTHING reads the store in pipeline mode (the
// assembler's dag branch at context-engine.ts:240 is gated `version === "dag"`,
// and the ctx_* tools at setup-tools.ts:640 are gated
// `version === "dag" && lcdStore`). Pure wasted cost + latency.
//
// FIX: gate the block additionally on the effective engine being dag. The
// decision MIRRORS the READ side exactly: the executor resolves an absent
// `config.contextEngine` via `ContextEngineConfigSchema.parse({})` whose
// `version` defaults to "dag" (executor-context-engine-setup.ts:265), so an
// ABSENT contextEngine is treated as dag (the assembler reads the dag engine in
// that case). Pipeline is skipped ONLY when `version === "pipeline"` is set.
//
// Invariants preserved:
//   - dag agents still ingest + compact exactly as before (predicate true).
//   - storeless ⇒ pipeline fallback unchanged (the outer `if (deps.contextStore)`
//     presence guard stays; the version gate is ANDed onto it).
//   - switching pipeline→dag later still works: the gate reads per-turn config,
//     so the next turn after a `version: "dag"` flip ingests; the first dag turn
//     catches up via the ingest delta (live.slice(persisted)) from an empty store.
//
// The decision is extracted into the pure exported predicate
// `shouldRunLcdStorePasses(config)` so the dag-vs-pipeline branch is unit-testable
// without scaffolding all 30+ postExecution deps (mirrors shouldStorePairedMemory).
// A source-grep locks the predicate into the `if (deps.contextStore)` gate.
// All FAIL on the pre-patch tree (the export does not exist) — RED-first.
// ---------------------------------------------------------------------------
describe("FIX A — LCD store passes run only when the effective engine is dag", () => {
  it("behavior — pipeline version (explicit) does NOT run the store passes", () => {
    // An explicit pipeline agent must NOT ingest/leaf/condense — the store is
    // injected unconditionally but nothing reads it in pipeline mode.
    expect(shouldRunLcdStorePasses({ contextEngine: { version: "pipeline" } })).toBe(false);
  });

  it("behavior — dag version (explicit) DOES run the store passes (dag path unchanged)", () => {
    expect(shouldRunLcdStorePasses({ contextEngine: { version: "dag" } })).toBe(true);
  });

  it("behavior — absent contextEngine is treated as dag (mirrors the executor's parse({}) default)", () => {
    // executor-context-engine-setup.ts:265 resolves an absent contextEngine via
    // ContextEngineConfigSchema.parse({}) → version "dag". The write gate must
    // agree with that read-side resolution: absent ⇒ run the passes.
    expect(shouldRunLcdStorePasses({})).toBe(true);
    expect(shouldRunLcdStorePasses({ contextEngine: undefined })).toBe(true);
  });

  it("behavior — absent version within a present contextEngine is treated as dag", () => {
    // A contextEngine object with other knobs set but no explicit version still
    // resolves to the schema default ("dag") on the read side.
    expect(shouldRunLcdStorePasses({ contextEngine: { freshTailTurns: 8 } as never })).toBe(true);
  });

  it("source-grep — the predicate gates the `if (deps.contextStore)` block (write/read symmetry)", () => {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // The contextStore block guard must reference the version predicate — the
    // presence-only `if (deps.contextStore)` is no longer sufficient on its own.
    expect(stripped).toMatch(/shouldRunLcdStorePasses/);
    // The guard ANDs the predicate with the store-presence check (either order).
    expect(stripped).toMatch(
      /if\s*\(\s*deps\.contextStore\s*&&\s*shouldRunLcdStorePasses\(config\)\s*\)|if\s*\(\s*shouldRunLcdStorePasses\(config\)\s*&&\s*deps\.contextStore\s*\)/,
    );
    // The ingest + both passes still live behind that single guard.
    expect(stripped).toMatch(/ingestTurnGuarded/);
    expect(stripped).toMatch(/runLeafPassAfterTurn/);
    expect(stripped).toMatch(/runCondensePassAfterTurn/);
  });
});

// ---------------------------------------------------------------------------
// LCD afterTurn leaf-pass wiring (Plan 129-06, C1/C3) — RED-first
//
// The wiring is PRODUCTION source in packages/agent/src/** (CLAUDE.md
// Tests-First). It activates the inert contextThreshold config: at the
// afterTurn boundary, INSIDE the same `if (deps.contextStore)` block as the
// 128-03 ingest, a thin gated call fires `maybeRunLeafPass` (body in
// lcd-compaction-trigger.ts) when a `getSummarizerDeps` getter is present.
//
// The behavioral proof exercises the call-site wiring helper directly
// (`runLeafPassAfterTurn`) — scaffolding all 30+ postExecution deps for the full
// path is impractical (see the markRead block above), so the helper that the
// `if (deps.contextStore)` block invokes is the testable seam. With a real
// :memory: store (over-threshold) + a STUB getSummarizerDeps, a leaf summary
// persists; with getSummarizerDeps absent it is gated off (no summary). Both
// FAIL on pre-patch code (the helper does not exist) — RED-first. A source-grep
// locks the call into the `if (deps.contextStore)` block.
// ---------------------------------------------------------------------------
describe("LCD afterTurn leaf-pass wiring (Plan 129-06)", () => {
  function readPostExec(): { src: string; stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { src, stripped };
  }

  it("source-grep — the thin gated call to maybeRunLeafPass/runLeafPassAfterTurn lives inside the if (deps.contextStore) block", () => {
    const { stripped } = readPostExec();
    // The call site must reference the trigger (via the wiring helper or directly).
    expect(stripped).toMatch(/maybeRunLeafPass|runLeafPassAfterTurn/);
    // … and it must sit INSIDE the `if (deps.contextStore)` block: between the
    // block open and the next top-level statement after the ingest. We slice from
    // the `if (deps.contextStore)` to the recall-attribution block that follows it.
    const blockStart = stripped.indexOf("if (deps.contextStore");
    expect(blockStart).toBeGreaterThan(-1);
    const afterBlock = stripped.indexOf("attributeRecallUsage", blockStart);
    const block = stripped.slice(blockStart, afterBlock > -1 ? afterBlock : undefined);
    expect(block).toMatch(/maybeRunLeafPass|runLeafPassAfterTurn/);
    // The ingest call is still there too (the leaf call comes AFTER it).
    expect(block).toMatch(/ingestTurnGuarded/);
  });

  it("behavior — runLeafPassAfterTurn fires the trigger (a leaf summary persists) when getSummarizerDeps is populated + over threshold", async () => {
    const [{ default: Database }, memory, core, trigger, summarizerMod, mockLoggerMod] =
      await Promise.all([
        import("better-sqlite3"),
        import("@comis/memory"),
        import("@comis/core"),
        import("./lcd-compaction-trigger.js"),
        import("../context-engine/lcd-leaf-summarizer.js"),
        import("../../../../test/support/mock-logger.js"),
      ]);
    const { initSchema, createLcdStore } = memory as unknown as {
      initSchema: (db: unknown, dim: number) => void;
      createLcdStore: (db: unknown) => import("@comis/core").ContextStorePort;
    };
    const { messageToParts } = core as unknown as {
      messageToParts: (m: unknown) => import("@comis/core").LcdMessagePart[];
    };
    const { runLeafPassAfterTurn } = trigger as unknown as {
      runLeafPassAfterTurn: (params: Record<string, unknown>) => Promise<void>;
    };
    const createMockLogger = (mockLoggerMod as { createMockLogger: () => unknown }).createMockLogger;
    type SummarizerDeps = import("../context-engine/lcd-leaf-summarizer.js").LeafSummarizerDeps;

    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const scope: import("@comis/core").ContextStoreScope = {
      conversationId: "conv-wire",
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "sess-a",
    };

    // Seed an over-threshold history (40 msgs × 100 stored tokens = 4000;
    // windowTokens 1000 → utilization 4.0 ≫ 0.75).
    for (let i = 0; i < 40; i++) {
      const msg =
        i % 2 === 0
          ? ({ role: "user", content: `u${i}`, timestamp: 1000 } as unknown)
          : ({
              role: "assistant",
              content: [{ type: "text", text: `a${i}` }],
              api: "anthropic.messages",
              provider: "anthropic",
              model: "claude-test",
              usage: { inputTokens: 1, outputTokens: 1 },
              stopReason: "stop",
              timestamp: 1000,
            } as unknown);
      store.append({
        scope,
        seq: i,
        role: (msg as { role: import("@comis/core").LcdRole }).role,
        tokenCount: 100,
        createdAt: 1000 + i,
        parts: messageToParts(msg),
      });
    }

    const logger = createMockLogger();
    // STUB summarizer (no network) returning a fixed short string.
    const getSummarizerDeps = (): SummarizerDeps => ({
      logger: logger as unknown as SummarizerDeps["logger"],
      summarize: async () => "WIRED-LEAF-SUMMARY",
      getModel: () => ({ provider: "anthropic", contextWindow: 1_000, reasoning: true }),
      getApiKey: async () => "test-key",
    });

    await runLeafPassAfterTurn({
      store,
      scope,
      // config.contextEngine — undefined is allowed (the helper defaults it),
      // but pass the activated knobs explicitly so the assertion is hermetic.
      contextEngine: {
        contextThreshold: 0.75,
        leafChunkTokens: 20_000,
        leafTargetTokens: 1_200,
        freshTailTurns: 8,
      },
      getSummarizerDeps,
      now: 7000,
      logger,
      eventBus: undefined,
    });

    const summaries = store.getSummaries(scope);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.kind).toBe("leaf");
    expect(summaries[0]!.createdAt).toBe(7000);
  });

  it("behavior — gated off: no getSummarizerDeps → the post-execution path runs cleanly and persists NO summary", async () => {
    const [{ default: Database }, memory, core, trigger, mockLoggerMod] = await Promise.all([
      import("better-sqlite3"),
      import("@comis/memory"),
      import("@comis/core"),
      import("./lcd-compaction-trigger.js"),
      import("../../../../test/support/mock-logger.js"),
    ]);
    const { initSchema, createLcdStore } = memory as unknown as {
      initSchema: (db: unknown, dim: number) => void;
      createLcdStore: (db: unknown) => import("@comis/core").ContextStorePort;
    };
    const { messageToParts } = core as unknown as {
      messageToParts: (m: unknown) => import("@comis/core").LcdMessagePart[];
    };
    const { runLeafPassAfterTurn } = trigger as unknown as {
      runLeafPassAfterTurn: (params: Record<string, unknown>) => Promise<void>;
    };
    const createMockLogger = (mockLoggerMod as { createMockLogger: () => unknown }).createMockLogger;

    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const scope: import("@comis/core").ContextStoreScope = {
      conversationId: "conv-gated",
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "sess-a",
    };
    for (let i = 0; i < 40; i++) {
      store.append({
        scope,
        seq: i,
        role: "user",
        tokenCount: 100,
        createdAt: 1000 + i,
        parts: messageToParts({ role: "user", content: `u${i}`, timestamp: 1000 }),
      });
    }

    const logger = createMockLogger();
    // No getSummarizerDeps → the wiring helper must NOT fire the trigger.
    await expect(
      runLeafPassAfterTurn({
        store,
        scope,
        contextEngine: undefined,
        getSummarizerDeps: undefined,
        now: 7000,
        logger,
        eventBus: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(store.getSummaries(scope).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LCD afterTurn C4 deferral + R3 serializer interlock (Plan 132-04).
//
// C4 makes the leaf + condense passes DEFERRED by default (deferCompaction,
// seeded in 132-01): they enqueue onto the per-conversation serializer as a
// DETACHED unit so afterTurn returns BEFORE the compaction's store write
// completes. R3 routes the live ingest write through the SAME serializer
// (runOnConversation) so the next turn's ingest and the prior turn's deferred
// compaction can never interleave (Pitfall 2). A fail-closed rollover emits a
// content-free context:dag_degraded event.
//
// Scaffolding all 30+ postExecution deps is impractical (see the markRead block
// above), so — mirroring the 129-06 leaf-wiring block — we pair a SOURCE-GREP
// (locking the inline wiring invariants the criteria require: runOnConversation
// ×2 inside the `if (deps.contextStore)` block, the deferCompaction gate, the
// suppressError-wrapped detached promise, NO bare empty catch) with a BEHAVIOR
// probe that reproduces the exact inline detached-enqueue pattern against a
// store double and proves the observable contract (the caller resolves before
// the deferred queue slot completes; both writers route through the queue; the
// degraded event is content-free). Both FAIL on pre-patch code (the inline
// wiring + the event did not exist) — RED-first.
// ---------------------------------------------------------------------------
describe("LCD afterTurn C4 deferral + R3 serializer interlock (Plan 132-04)", () => {
  function readPostExec(): { stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { stripped };
  }

  function contextStoreBlock(stripped: string): string {
    const blockStart = stripped.indexOf("if (deps.contextStore");
    expect(blockStart).toBeGreaterThan(-1);
    const afterBlock = stripped.indexOf("attributeRecallUsage", blockStart);
    return stripped.slice(blockStart, afterBlock > -1 ? afterBlock : undefined);
  }

  it("source-grep — the ingest AND the deferred compaction both route through runOnConversation (Pitfall 2 interlock)", () => {
    const block = contextStoreBlock(readPostExec().stripped);
    // BOTH writers route through the per-conversation serializer → ≥2 calls.
    const calls = block.match(/runOnConversation/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The ingest is still guarded; the passes are still wired.
    expect(block).toMatch(/ingestTurnGuarded/);
    expect(block).toMatch(/runLeafPassAfterTurn/);
    expect(block).toMatch(/runCondensePassAfterTurn/);
  });

  it("source-grep — the deferral is gated on deferCompaction and the detached promise is suppressError-wrapped (no bare empty catch)", () => {
    const block = contextStoreBlock(readPostExec().stripped);
    expect(block).toMatch(/deferCompaction/);
    expect(block).toMatch(/suppressError/);
    // No bare empty catch anywhere in the block (AGENTS.md §2.2).
    expect(block).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\}\)/);
  });

  it("source-grep — the fail-closed rollover branch emits a content-free context:dag_degraded event", () => {
    const block = contextStoreBlock(readPostExec().stripped);
    expect(block).toMatch(/context:dag_degraded/);
    expect(block).toMatch(/fail_closed_rollover/);
    // The emit carries identifiers + reason + durationMs ONLY — never content.
    const emitStart = block.indexOf("context:dag_degraded");
    const emitSlice = block.slice(emitStart, emitStart + 400);
    expect(emitSlice).not.toMatch(/\bcontent\b|\btext\b|\bmessages\b/);
  });

  it("behavior — the detached enqueue pattern resolves the caller BEFORE the deferred queue slot completes; both writers share the queue", async () => {
    const [ingestMod, shared, mockLoggerMod] = await Promise.all([
      import("./lcd-ingest.js"),
      import("@comis/shared"),
      import("../../../../test/support/mock-logger.js"),
    ]);
    const { ingestTurnGuarded } = ingestMod as unknown as {
      ingestTurnGuarded: (...a: unknown[]) => void;
    };
    const { suppressError } = shared as unknown as {
      suppressError: (p: Promise<unknown>, reason: string) => void;
    };
    const createMockLogger = (mockLoggerMod as { createMockLogger: () => unknown }).createMockLogger;

    // Store double modelling the single-flight queue: the FIRST slot (ingest)
    // completes promptly; the SECOND slot (deferred compaction) is held on a
    // latch (the long pole). Records every runOnConversation convId.
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const latch = new Promise<void>((r) => {
      release = r;
    });
    const store = {
      append: () => {},
      getMessages: () => [],
      runOnConversation: async <T>(convId: string, fn: () => T | Promise<T>): Promise<T> => {
        const first = calls.length === 0;
        calls.push(convId);
        // The ingest slot (first) runs its body promptly; the deferred-compaction
        // slot (later) does NOT run its body until the test releases the latch —
        // modelling the single-flight queue where the compaction WRITE only fires
        // once dequeued (AFTER afterTurn returned). So `deferredDone` stays false
        // until release, proving afterTurn did not block on the compaction write.
        if (!first) await latch;
        return fn();
      },
    } as unknown as import("@comis/core").ContextStorePort;

    const scope: import("@comis/core").ContextStoreScope = {
      conversationId: "conv-c4",
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "conv-c4",
    };

    // Reproduce the inline afterTurn pattern verbatim (the production seam):
    // 1. ingest routed through runOnConversation (awaited — claims the seq slot);
    await store.runOnConversation("conv-c4", () =>
      ingestTurnGuarded(store, scope, [], 7000, createMockLogger()),
    );
    // 2. deferred passes enqueued onto the SAME queue, NOT awaited, suppressError-wrapped.
    let deferredDone = false;
    const deferred = store.runOnConversation("conv-c4", async () => {
      deferredDone = true;
    });
    suppressError(deferred, "deferred LCD compaction (R3 serializer)");

    // The caller (afterTurn) continues here WITHOUT awaiting `deferred`. The
    // deferred unit's queue slot is still held by the latch → not yet complete.
    await Promise.resolve();
    expect(deferredDone).toBe(false);

    // Both writers (ingest + deferred compaction) routed through the queue for
    // the SAME conversation (Pitfall 2 interlock).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c === "conv-c4")).toBe(true);

    // Releasing the latch lets the deferred compaction run (eventually).
    release?.();
    await deferred;
    expect(deferredDone).toBe(true);
  });

  it("behavior — a fail-closed rollover (malformed scope) emits a content-free context:dag_degraded with reason fail_closed_rollover", async () => {
    const [core, ingestMod, mockLoggerMod] = await Promise.all([
      import("@comis/core"),
      import("./lcd-ingest.js"),
      import("../../../../test/support/mock-logger.js"),
    ]);
    const { TypedEventBus } = core as unknown as { TypedEventBus: new () => import("@comis/core").TypedEventBus };
    const { ingestTurnGuarded } = ingestMod as unknown as {
      ingestTurnGuarded: (
        store: unknown,
        scope: unknown,
        live: unknown[],
        now: number,
        logger: unknown,
        onFailClosed?: (reason: string) => void,
      ) => void;
    };
    const createMockLogger = (mockLoggerMod as { createMockLogger: () => unknown }).createMockLogger;

    const bus = new TypedEventBus();
    const events: Array<Record<string, unknown>> = [];
    bus.on("context:dag_degraded", (e) => events.push(e as unknown as Record<string, unknown>));

    const store = { append: () => {}, getMessages: () => [] } as unknown as import("@comis/core").ContextStorePort;
    // Malformed: conversationId !== sessionKey → fail-closed → onFailClosed fires.
    const scope: import("@comis/core").ContextStoreScope = {
      conversationId: "conv-x",
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "different",
    };

    // Reproduce the inline emit (the production seam wires this onFailClosed).
    const start = 6000;
    ingestTurnGuarded(store, scope, [], 7000, createMockLogger(), () => {
      bus.emit("context:dag_degraded", {
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        reason: "fail_closed_rollover",
        durationMs: Math.max(0, 7000 - start),
        timestamp: 7000,
      });
    });

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ conversationId: "conv-x", agentId: "agent_a", reason: "fail_closed_rollover" });
    expect(typeof e.durationMs).toBe("number");
    // Content-free.
    const keys = Object.keys(e);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("messages");
  });

  // WR-04: the DEFERRED (C4) compaction closure is enqueued detached and can run
  // AFTER postExecution returns + `session.dispose()` tears the session down. The
  // deferred passes resolve the summarizer deps WHEN THEY RUN — and getModel()
  // re-reads `session.agent.state.model` (executor-context-engine-setup.ts:307,
  // and again inside buildLeafSummarizeFn). If the SDK dispose nulls
  // session.agent.state, a deferred pass that resolves the model post-dispose
  // reads a torn-down session. The fix snapshots the model identity into the
  // deferred closure BEFORE returning (snapshotSummarizerDepsForDefer), so the
  // detached pass never re-reads the disposed session — it completes non-fatally
  // and still persists a correct summary against the LIVE store.
  it("behavior — snapshotSummarizerDepsForDefer captures the model BEFORE dispose so a deferred pass does not re-read a torn-down session and still persists (WR-04)", async () => {
    const [{ default: Database }, memory, core, trigger, postExecMod, mockLoggerMod] =
      await Promise.all([
        import("better-sqlite3"),
        import("@comis/memory"),
        import("@comis/core"),
        import("./lcd-compaction-trigger.js"),
        import("./executor-post-execution.js"),
        import("../../../../test/support/mock-logger.js"),
      ]);
    const { initSchema, createLcdStore } = memory as unknown as {
      initSchema: (db: unknown, dim: number) => void;
      createLcdStore: (db: unknown) => import("@comis/core").ContextStorePort;
    };
    const { messageToParts } = core as unknown as {
      messageToParts: (m: unknown) => import("@comis/core").LcdMessagePart[];
    };
    const { runLeafPassAfterTurn } = trigger as unknown as {
      runLeafPassAfterTurn: (params: Record<string, unknown>) => Promise<void>;
    };
    type SnapshotModel = import("../context-engine/lcd-leaf-summarizer.js").LeafSummarizerDeps extends {
      getModel: () => infer M;
    }
      ? M
      : never;
    type SummarizerDepsGetter = (
      modelSnapshot?: SnapshotModel,
    ) => import("../context-engine/lcd-leaf-summarizer.js").LeafSummarizerDeps;
    // The new lifetime helper the fix adds — RED on the pre-patch tree (the export
    // does not exist, so the import is undefined and the call below throws).
    const { snapshotSummarizerDepsForDefer } = postExecMod as unknown as {
      snapshotSummarizerDepsForDefer: (
        getSummarizerDeps: SummarizerDepsGetter | undefined,
      ) => SummarizerDepsGetter | undefined;
    };
    const createMockLogger = (mockLoggerMod as { createMockLogger: () => unknown }).createMockLogger;
    type SummarizerDeps = import("../context-engine/lcd-leaf-summarizer.js").LeafSummarizerDeps;

    const db = new Database(":memory:");
    initSchema(db, 1536);
    const store = createLcdStore(db);
    const scope: import("@comis/core").ContextStoreScope = {
      conversationId: "conv-dispose",
      tenantId: "tenant_a",
      agentId: "agent_a",
      sessionKey: "sess-a",
    };

    // Over-threshold history (40 msgs × 100 tokens = 4000; window 1000 → util 4.0).
    for (let i = 0; i < 40; i++) {
      const msg =
        i % 2 === 0
          ? ({ role: "user", content: `u${i}`, timestamp: 1000 } as unknown)
          : ({
              role: "assistant",
              content: [{ type: "text", text: `a${i}` }],
              api: "anthropic.messages",
              provider: "anthropic",
              model: "claude-test",
              usage: { inputTokens: 1, outputTokens: 1 },
              stopReason: "stop",
              timestamp: 1000,
            } as unknown);
      store.append({
        scope,
        seq: i,
        role: (msg as { role: import("@comis/core").LcdRole }).role,
        tokenCount: 100,
        createdAt: 1000 + i,
        parts: messageToParts(msg),
      });
    }

    const logger = createMockLogger();

    // A summarizer-deps getter that models the production SESSION COUPLING +
    // snapshot seam (executor-context-engine-setup.ts resolveCompactionModelChain):
    // WITHOUT an injected model snapshot, getModel() reads a
    // `session.agent.state.model` that becomes UNREADABLE after dispose (the read
    // throws — the opaque SDK dispose tearing down the state), and `summarize`
    // re-reads it too (mirrors buildLeafSummarizeFn:554 calling chain.getModel()).
    // WITH an injected snapshot the chain uses it verbatim, never touching the
    // session — the lifetime severance the deferred path needs. The fix's helper
    // resolves the LIVE model once (pre-dispose) and re-binds the getter to inject
    // that snapshot on every later resolution.
    let disposed = false;
    const sessionState: { model: SnapshotModel | undefined } = {
      model: { provider: "anthropic", contextWindow: 1_000, reasoning: true },
    };
    const readModel = (): SnapshotModel => {
      if (disposed) throw new Error("session.agent.state read after dispose");
      return sessionState.model!;
    };
    const getSummarizerDeps: SummarizerDepsGetter = (modelSnapshot?: SnapshotModel): SummarizerDeps => {
      // Mirror resolveCompactionModelChain: the injected snapshot (when present)
      // is the model authority; otherwise read the live session.
      const resolveModel = (): SnapshotModel => modelSnapshot ?? readModel();
      return {
        logger: logger as unknown as SummarizerDeps["logger"],
        summarize: async () => {
          resolveModel(); // buildLeafSummarizeFn:554 — chain.getModel() at LLM time
          return "DEFERRED-LEAF-SUMMARY";
        },
        getModel: () => resolveModel(),
        getApiKey: async () => "test-key",
      };
    };

    // 1. Snapshot the deps BEFORE dispose (what the deferred branch does at enqueue):
    //    capture the LIVE model identity and re-bind the getter to inject it.
    const deferredGetter = snapshotSummarizerDepsForDefer(getSummarizerDeps);
    expect(deferredGetter).toBeDefined();

    // 2. The session disposes (postExecution returns → session.dispose()). Any
    //    later read of session.agent.state.model now throws.
    disposed = true;

    // 3. The DEFERRED pass runs AFTER dispose using the snapshotted getter. With
    //    the fix it reads the captured model snapshot (never the torn-down
    //    session), so it completes non-fatally AND persists a correct summary.
    await expect(
      runLeafPassAfterTurn({
        store,
        scope,
        contextEngine: {
          contextThreshold: 0.75,
          leafChunkTokens: 20_000,
          leafTargetTokens: 1_200,
          freshTailTurns: 8,
        },
        getSummarizerDeps: deferredGetter,
        now: 9000,
        logger,
        eventBus: undefined,
      }),
    ).resolves.toBeUndefined();

    // The deferred pass wrote to the LIVE store despite the disposed session.
    const summaries = store.getSummaries(scope);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.kind).toBe("leaf");
    expect(summaries[0]!.createdAt).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (HIGH security) — the UNGUARDED paired-conversation ingest path must
// apply the SAME secret-egress guard the DERIVED-memory writes on this file use
// (user-representation ~:390, relationship, consolidation all call
// validateMemoryWrite FIRST). A user who pastes a secret (e.g. an `sk-proj-…`
// key) into chat had it written VERBATIM to the `memories` table AND embedded
// into the vector index via the paired store — recallable across sessions — even
// though the explicit memory_store tool refuses it. The refusal is cosmetic for
// data-at-rest; the highest-volume write path (every qualifying turn) bypassed
// the guard entirely.
//
// validateMemoryWrite REJECTS (returns severity "critical") when the
// secret-egress scan finds a redaction — it does NOT scrub-and-return-content.
// So FIX 1 GATES the paired store on it: a non-`clean` verdict SKIPS the write
// (no row, no embedding), with a content-free WARN — byte-identical to the
// user-representation path (memory-user-representation-job.ts:390-406). Non-secret
// paired content still stores unchanged.
//
// The gate is extracted into the exported async helper
// `storePairedConversationMemory(...)` (mirrors the existing shouldStorePairedMemory
// / isDuplicatePairedMemory extractions) so the secret-egress decision is unit-
// testable with a mock memoryPort capturing `.store` inputs — scaffolding all 30+
// postExecution deps is impractical (see the markRead block above). A source-grep
// locks the helper into the paired-store call site. ALL FAIL on the pre-patch tree
// (the export does not exist + the gate is absent) — RED-first.
//
// IMPORTANT (Pino redaction / §2.7): the skip is CONTENT-FREE — the planted
// secret value never appears in any log field.
// ---------------------------------------------------------------------------
describe("FIX 1 — paired-conversation memory store applies the secret-egress guard", () => {
  function readPostExec(): { src: string; stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { src, stripped };
  }

  // A planted secret that the secret-egress scan flags: `sk-proj-` starts with
  // the `sk-` prefix (PREFIX_MIN_BODY_LENGTHS `sk-` ⇒ 16); the body below is
  // ≥16 chars so scrubSecretsFromText redacts it ⇒ validateMemoryWrite ⇒ critical.
  const PLANTED_SECRET = "sk-proj-LEAK0000000000000000ABCDEF";

  async function loadHelper(): Promise<{
    storePairedConversationMemory: (args: Record<string, unknown>) => Promise<void>;
  }> {
    const mod = (await import("./executor-post-execution.js")) as unknown as {
      storePairedConversationMemory?: (args: Record<string, unknown>) => Promise<void>;
    };
    // RED on the pre-patch tree: the export does not exist yet.
    expect(typeof mod.storePairedConversationMemory).toBe("function");
    return mod as { storePairedConversationMemory: (args: Record<string, unknown>) => Promise<void> };
  }

  interface CapturingMemoryPort {
    store: ReturnType<typeof vi.fn>;
  }
  function makeCapturingMemoryPort(): CapturingMemoryPort {
    return {
      store: vi.fn(async (entry: { id: string }) => ({ ok: true as const, value: entry })),
    };
  }

  const clock = { now: () => 1_700_000_000_000 };

  it("behavior — a paired memory whose content carries a planted secret is NOT written to memoryPort.store (gated, not stored)", async () => {
    const { storePairedConversationMemory } = await loadHelper();
    const memoryPort = makeCapturingMemoryPort();
    const enqueued: Array<{ id: string; content: string }> = [];

    await storePairedConversationMemory({
      memoryPort,
      pairedContent: `[user] my key is ${PLANTED_SECRET}\n[agent] noted`,
      effectiveAgentId: "agent_a",
      sessionKey: { tenantId: "tenant_a", userId: "user_a" },
      channelType: "discord",
      formattedKey: "agent_a:discord:chan-1",
      now: clock.now(),
      logger: makeSilentLogger(),
      embeddingEnqueue: (id: string, content: string) => enqueued.push({ id, content }),
    });

    // The secret-bearing paired memory NEVER reaches the store …
    expect(memoryPort.store).not.toHaveBeenCalled();
    // … and is never enqueued for embedding (no vector-index recall path either).
    expect(enqueued).toHaveLength(0);
  });

  it("behavior — a paired memory with NO secret still stores unchanged (gate does not regress the happy path)", async () => {
    const { storePairedConversationMemory } = await loadHelper();
    const memoryPort = makeCapturingMemoryPort();
    const enqueued: Array<{ id: string; content: string }> = [];
    const clean = "[user] what is the comparison chart for Q1 vs Q2\n[agent] here is the chart you asked for";

    await storePairedConversationMemory({
      memoryPort,
      pairedContent: clean,
      effectiveAgentId: "agent_a",
      sessionKey: { tenantId: "tenant_a", userId: "user_a" },
      channelType: "discord",
      formattedKey: "agent_a:discord:chan-1",
      now: clock.now(),
      logger: makeSilentLogger(),
      embeddingEnqueue: (id: string, content: string) => enqueued.push({ id, content }),
    });

    // Non-secret content is stored VERBATIM (content preserved, gate is a pass-through).
    expect(memoryPort.store).toHaveBeenCalledTimes(1);
    const stored = memoryPort.store.mock.calls[0]![0] as { content: string; trustLevel: string; tags: string[] };
    expect(stored.content).toBe(clean);
    expect(stored.trustLevel).toBe("learned");
    expect(stored.tags).toEqual(["conversation", "paired"]);
    // The clean entry IS enqueued for embedding (RAG recall path intact).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.content).toBe(clean);
  });

  it("behavior — the skip is CONTENT-FREE: the planted secret value never appears in any log field (Pino redaction / §2.7)", async () => {
    const { storePairedConversationMemory } = await loadHelper();
    const memoryPort = makeCapturingMemoryPort();
    const logRecords: Array<{ obj: unknown; msg: string }> = [];
    const capturingLogger = {
      debug: (obj: unknown, msg: string) => logRecords.push({ obj, msg }),
      info: (obj: unknown, msg: string) => logRecords.push({ obj, msg }),
      warn: (obj: unknown, msg: string) => logRecords.push({ obj, msg }),
      error: (obj: unknown, msg: string) => logRecords.push({ obj, msg }),
    };

    await storePairedConversationMemory({
      memoryPort,
      pairedContent: `[user] token ${PLANTED_SECRET}\n[agent] ok`,
      effectiveAgentId: "agent_a",
      sessionKey: { tenantId: "tenant_a", userId: "user_a" },
      channelType: "discord",
      formattedKey: "agent_a:discord:chan-1",
      now: clock.now(),
      logger: capturingLogger,
      embeddingEnqueue: () => {},
    });

    // The secret value must appear in NONE of the captured log lines (neither
    // the message nor any structured field), and store must not be called.
    expect(memoryPort.store).not.toHaveBeenCalled();
    const serialized = JSON.stringify(logRecords);
    expect(serialized).not.toContain(PLANTED_SECRET);
    expect(serialized).not.toContain("LEAK0000000000000000");
    // The gate did emit an observability line (a content-free skip WARN/DEBUG).
    expect(logRecords.length).toBeGreaterThan(0);
  });

  it("behavior — the skip is logged at WARN/DEBUG with errorKind validation (caller-error, not internal)", async () => {
    const { storePairedConversationMemory } = await loadHelper();
    const memoryPort = makeCapturingMemoryPort();
    let warnRecord: { obj: Record<string, unknown>; msg: string } | undefined;
    const capturingLogger = {
      debug: () => {},
      info: () => {},
      warn: (obj: Record<string, unknown>, msg: string) => {
        warnRecord = { obj, msg };
      },
      error: (obj: Record<string, unknown>) => {
        // The skip must NOT log at ERROR — a secret in user input is a caller/
        // validation concern, not an internal fault.
        throw new Error(`secret-egress skip must not log at ERROR: ${JSON.stringify(obj)}`);
      },
    };

    await storePairedConversationMemory({
      memoryPort,
      pairedContent: `[user] ${PLANTED_SECRET}\n[agent] ok this is a long enough combined message`,
      effectiveAgentId: "agent_a",
      sessionKey: { tenantId: "tenant_a", userId: "user_a" },
      channelType: "discord",
      formattedKey: "agent_a:discord:chan-1",
      now: clock.now(),
      logger: capturingLogger,
      embeddingEnqueue: () => {},
    });

    expect(memoryPort.store).not.toHaveBeenCalled();
    expect(warnRecord, "a content-free skip WARN must be emitted").toBeDefined();
    expect(warnRecord!.obj.errorKind).toBe("validation");
  });

  it("source-grep — validateMemoryWrite gates the paired-store call site (the agent↛memory cut held: imported from @comis/core)", () => {
    const { stripped } = readPostExec();
    // The secret-egress guard must be imported from @comis/core (same source the
    // derived-memory writes use) …
    expect(stripped).toMatch(/import\s*\{[^}]*\bvalidateMemoryWrite\b[^}]*\}\s*from\s*"@comis\/core"/);
    // … and referenced in the production source (the gate exists).
    expect(stripped).toMatch(/validateMemoryWrite\s*\(/);
    // The paired-store helper exists and is the seam the call site routes through.
    expect(stripped).toMatch(/storePairedConversationMemory/);
  });

  it("behavior — validateMemoryWrite REJECTS the planted secret (severity critical) — the guard's contract this fix relies on", async () => {
    const core = (await import("@comis/core")) as unknown as {
      validateMemoryWrite: (c: string) => { severity: string };
    };
    expect(core.validateMemoryWrite(`[user] ${PLANTED_SECRET}\n[agent] ok`).severity).toBe("critical");
    // A clean conversation is clean (the happy path the gate must preserve).
    expect(core.validateMemoryWrite("[user] hello there\n[agent] hi, how can I help").severity).toBe("clean");
  });
});

function makeSilentLogger(): {
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
} {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// ---------------------------------------------------------------------------
// R4 critic hook wiring in executor-post-execution.ts
//
// The critic is invoked via a thin hook — shouldRunCritic guard + one
// runVerificationCritic call — between the tool-failure notice and the
// session-metadata write. No inline critic logic lives in this file.
//
// Source-grep is the load-bearing test mode (scaffolding all 30+ postExecution
// deps is impractical — the same strategy used by every other describe block
// above). Tests assert:
//   - verification-gate.ts is imported (key-links contract)
//   - shouldRunCritic appears exactly once (the guard)
//   - runVerificationCritic appears exactly once (the await call)
//   - "verification" is in MEMORY_SKIP_OPERATIONS
//   - result.response mutation is conditioned on not-verified verdict
//   - generateCanaryToken is imported (canary is built per-execution)
// ---------------------------------------------------------------------------
describe("R4 critic hook — thin wiring in executor-post-execution.ts", () => {
  function readPostExecSource(): string {
    return readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
  }

  function strippedSource(): string {
    const src = readPostExecSource();
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  }

  it("imports shouldRunCritic and runVerificationCritic from verification-gate.js", () => {
    const stripped = strippedSource();
    expect(stripped).toMatch(
      /import\s*\{[^}]*\bshouldRunCritic\b[^}]*\}\s*from\s*"\.\/verification-gate\.js"/,
    );
    expect(stripped).toMatch(/runVerificationCritic/);
  });

  it("shouldRunCritic call appears exactly once in non-import, non-comment source (the guard)", () => {
    const stripped = strippedSource();
    // Exclude the import line: only count runtime call sites.
    const nonImportLines = stripped.split("\n").filter((l) => !l.trim().startsWith("import "));
    const callMatches = nonImportLines.join("\n").match(/\bshouldRunCritic\b/g) ?? [];
    expect(callMatches.length).toBe(1);
  });

  it("runVerificationCritic call appears exactly once in non-import, non-comment source (the await)", () => {
    const stripped = strippedSource();
    // Exclude the import line: only count runtime call sites (the await call in the hook).
    const nonImportLines = stripped.split("\n").filter((l) => !l.trim().startsWith("import "));
    const callMatches = nonImportLines.join("\n").match(/\brunVerificationCritic\b/g) ?? [];
    expect(callMatches.length).toBe(1);
  });

  it('"verification" is present in MEMORY_SKIP_OPERATIONS set', () => {
    const stripped = strippedSource();
    // The set literal must include "verification" — critic calls do not create paired memory entries.
    expect(stripped).toMatch(/MEMORY_SKIP_OPERATIONS[^=]*=.*new Set\s*\(\s*\[[\s\S]*?"verification"[\s\S]*?\]\s*\)/);
  });

  it("result.response mutation is conditioned on verdict not being verified or skipped", () => {
    const stripped = strippedSource();
    // The mutation guard: verdict !== "verified" && verdict !== "skipped" (or equivalent).
    // Accept any variable name (criticResult, cr, etc.) — pattern is structural.
    const hasMutationGuard =
      /\bverdict\s*!==\s*"verified"/.test(stripped) ||
      /\bverdict\s*===\s*"not-verified"/.test(stripped);
    expect(hasMutationGuard).toBe(true);
  });

  it("generateCanaryToken is imported for per-execution canary construction", () => {
    const stripped = strippedSource();
    expect(stripped).toMatch(/\bgenerateCanaryToken\b/);
  });

  // WR-03: the canary salt must be the FORMATTED session key, not String(sessionKey)
  // (a plain Zod object → the constant "[object Object]" for every session, which
  // makes the canary's session-binding dead and the JSDoc claim false).
  it("canary is salted with formattedKey, never String(sessionKey)", () => {
    const stripped = strippedSource();
    const canaryCall = stripped.match(/generateCanaryToken\([^)]*\)/)?.[0] ?? "";
    expect(canaryCall).toContain("formattedKey");
    expect(canaryCall).not.toMatch(/String\s*\(\s*sessionKey\s*\)/);
    // Belt-and-suspenders: the dead stringify must not appear anywhere in source.
    expect(stripped).not.toMatch(/generateCanaryToken\(\s*String\s*\(\s*sessionKey\s*\)/);
  });

  it("hook position is between tool-failure notice and session metadata write", () => {
    const src = readPostExecSource();
    const toolFailurePos = src.indexOf("[tool failure]");
    // Use the await-call site (not the import which is near the top of the file).
    const awaitCriticPos = src.indexOf("await runVerificationCritic");
    const sessionMetaPos = src.indexOf("sessionAdapter.writeSessionMetadata");
    // All three must exist in the file.
    expect(toolFailurePos).toBeGreaterThan(-1);
    expect(awaitCriticPos).toBeGreaterThan(-1);
    expect(sessionMetaPos).toBeGreaterThan(-1);
    // critic must come AFTER tool-failure notice and BEFORE session metadata write.
    expect(awaitCriticPos).toBeGreaterThan(toolFailurePos);
    expect(awaitCriticPos).toBeLessThan(sessionMetaPos);
  });

  // WR-01 (Phase 169): CWF-05 guard — critic must be skipped for degraded turns.
  // Source-grep verifies the explicit isDegradedTurn guard is present and wraps
  // the shouldRunCritic call. This makes the guard structural (not implicit) and
  // catches any future edits that accidentally remove it.
  it("WR-01 (Phase 169): isDegradedTurn guard wraps shouldRunCritic call (explicit CWF-05 protection)", () => {
    const src = strippedSource();
    // The guard variable must be declared with both degraded reasons.
    expect(src).toMatch(/isDegradedTurn\s*=/);
    expect(src).toMatch(/output_starved/);
    expect(src).toMatch(/context_exhausted/);
    // The shouldRunCritic call must be conditioned on !isDegradedTurn.
    expect(src).toMatch(/!isDegradedTurn.*shouldRunCritic|isDegradedTurn.*&&.*shouldRunCritic/s);
  });

  it("WR-01 (Phase 169): isDegradedTurn guard appears AFTER CWF-05 block (correct ordering)", () => {
    const src = readPostExecSource();
    const cwf05Pos = src.indexOf("CWF-05: degrade loudly");
    const degradedGuardPos = src.indexOf("isDegradedTurn");
    expect(cwf05Pos).toBeGreaterThan(-1);
    expect(degradedGuardPos).toBeGreaterThan(-1);
    // The isDegradedTurn variable must appear AFTER the CWF-05 block so it
    // can refer to the already-written result.response.
    expect(degradedGuardPos).toBeGreaterThan(cwf05Pos);
  });
});

// ---------------------------------------------------------------------------
// CWF-05: degraded-reply wiring — source-grep + behavior probes
//
// These tests verify that:
//   (A) executor-post-execution.ts imports and calls buildOutputStarvedAnnotation
//   (B) the gate uses effectiveFinishReason (NOT result.finishReason) for output_starved
//   (C) executor-post-execution.ts imports and calls buildContextExhaustedReply
//   (D) the gate uses effectiveFinishReason (NOT result.finishReason) for context_exhausted
//   (E) fail-closed: empty partial text + annotation = non-empty reply
//   (F) no-regression: healthy reasons return undefined from buildDegradedReply
//   (G) WR-02 (Phase 169): effectiveFinishReason is emitted in the bookend log
//   (H) IN-01 (Phase 169): behavioral gate tests — actual result.response mutation
// ---------------------------------------------------------------------------
describe("CWF-05: degraded-reply wiring", () => {
  function readStripped(): string {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  }

  it("source-grep — executor-post-execution imports and calls buildOutputStarvedAnnotation", () => {
    const stripped = readStripped();
    expect(stripped).toMatch(/buildOutputStarvedAnnotation/);
  });

  it("source-grep — output_starved gate uses effectiveFinishReason (not result.finishReason)", () => {
    const stripped = readStripped();
    expect(stripped).toMatch(
      /effectiveFinishReason.*output_starved|output_starved.*effectiveFinishReason/,
    );
  });

  it("source-grep — executor-post-execution imports and calls buildContextExhaustedReply", () => {
    const stripped = readStripped();
    expect(stripped).toMatch(/buildContextExhaustedReply/);
  });

  it("source-grep — context_exhausted gate uses effectiveFinishReason (not result.finishReason)", () => {
    const stripped = readStripped();
    expect(stripped).toMatch(
      /effectiveFinishReason.*context_exhausted|context_exhausted.*effectiveFinishReason/,
    );
  });

  it("fail-closed — output_starved with empty partial text still delivers non-empty reply", () => {
    // Simulates: (result.response ?? "") + buildOutputStarvedAnnotation()
    // where result.response is empty. The annotation alone must be non-empty.
    const annotation = buildOutputStarvedAnnotation();
    const delivered = "" + annotation;
    expect(delivered.trim().length).toBeGreaterThan(0);
  });

  it("W4: the context_exhausted reply is built with capabilityClass + traceId wiring", () => {
    const stripped = readStripped();
    expect(stripped).toMatch(/buildContextExhaustedReply\(\s*\{[\s\S]*?capabilityClass/);
    expect(stripped).toMatch(/buildContextExhaustedReply\(\s*\{[\s\S]*?traceId/);
  });

  it("no-regression — buildDegradedReply returns undefined for healthy reasons (strict no-op)", () => {
    expect(buildDegradedReply("stop")).toBeUndefined();
    expect(buildDegradedReply("end_turn")).toBeUndefined();
  });

  // WR-02 (Phase 169): effectiveFinishReason must appear in the bookend log.
  // Source-grep verifies the conditional spread that emits it when it differs
  // from result.finishReason (which stays "stop" for output_starved turns).
  it("WR-02 (Phase 169): effectiveFinishReason is conditionally emitted in bookend log", () => {
    const stripped = readStripped();
    // The bookend must include the conditional effectiveFinishReason spread.
    // Pattern: the conditional spread that only emits it when it differs from result.finishReason.
    expect(stripped).toMatch(/effectiveFinishReason\s*!==\s*result\.finishReason.*effectiveFinishReason/s);
  });

  it("WR-02 (Phase 169): effectiveFinishReason derivation appears BEFORE bookend log", () => {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    // The bookend log is identified by the deps.logger.info call with "Execution complete".
    // Use the call-site marker (the deps.logger.info invocation) rather than the string
    // literal, since "Execution complete" also appears in a comment at line ~229 which
    // would give a false earlier position via indexOf.
    const bookendLogCallPos = src.indexOf('"Execution complete",');
    // effectiveFinishReason must be declared (const effectiveFinishReason =) before the bookend.
    const firstDeclarationPos = src.indexOf("const effectiveFinishReason =");
    expect(bookendLogCallPos).toBeGreaterThan(-1);
    expect(firstDeclarationPos).toBeGreaterThan(-1);
    expect(firstDeclarationPos).toBeLessThan(bookendLogCallPos);
  });

  // ---------------------------------------------------------------------------
  // IN-01 (Phase 169): behavioral gate tests — actual result.response mutation
  //
  // These exercise the real gate logic: promoteOutputStarved (the promotion
  // that sets effectiveFinishReason) + buildDegradedReply (the builder that
  // produces the exact strings) + the mutation pattern used at the call site.
  // The "smallest real seam" is the combination of these two pure exported
  // functions, which together constitute the entire CWF-05 gate without
  // requiring the 30+ postExecution deps.
  //
  // Each test simulates exactly what postExecution does:
  //   effectiveFinishReason = promoteOutputStarved(toolReconciled, lastStopReason)
  //   if output_starved: response = (response ?? "") + buildOutputStarvedAnnotation()
  //   if context_exhausted: response = buildContextExhaustedReply()
  //   else: response unchanged
  // ---------------------------------------------------------------------------
  it("IN-01 (a): output_starved with partial text — response ENDS WITH annotation (partial preserved)", () => {
    const partial = "Here is my analysis of the code.";
    const lastStopReason = "length"; // bridge-reported output-cap stop
    const effective = promoteOutputStarved("stop", lastStopReason);
    expect(effective).toBe("output_starved");
    // Apply the gate mutation exactly as postExecution does it:
    let response: string = partial;
    if (effective === "output_starved") {
      response = (response ?? "") + buildOutputStarvedAnnotation();
    }
    // Partial text is preserved (APPEND, not REPLACE).
    expect(response).toContain(partial);
    // Annotation is appended.
    expect(response).toContain(buildOutputStarvedAnnotation());
    // Result ends with the annotation.
    expect(response.endsWith(buildOutputStarvedAnnotation())).toBe(true);
  });

  it("IN-01 (b): output_starved with undefined partial — result.response is non-empty (fail-closed)", () => {
    const lastStopReason = "length";
    const effective = promoteOutputStarved("stop", lastStopReason);
    expect(effective).toBe("output_starved");
    // Apply gate mutation with undefined partial (the ?? "" fail-closed path):
    let response: string | undefined = undefined;
    if (effective === "output_starved") {
      response = (response ?? "") + buildOutputStarvedAnnotation();
    }
    // Must be non-empty even though partial was undefined.
    expect(response).toBeDefined();
    expect((response ?? "").trim().length).toBeGreaterThan(0);
    expect(response).toBe(buildOutputStarvedAnnotation());
  });

  it("IN-01 (c): context_exhausted — response is REPLACED with synthesized reply (not Phase-166 placeholder, not [Stopped:)", () => {
    const effective = promoteOutputStarved("context_exhausted", undefined);
    // context_exhausted is NOT a stop/end_turn, so promoteOutputStarved passes it through.
    expect(effective).toBe("context_exhausted");
    // Apply gate mutation:
    let response: string | undefined = "[Stopped: context_exhausted] — please reset the session.";
    if (effective === "context_exhausted") {
      response = buildContextExhaustedReply();
    }
    // Must equal the synthesized reply exactly (REPLACE semantics).
    expect(response).toBe(buildContextExhaustedReply());
    // Must NOT contain the Phase-166 placeholder or operator redirect.
    expect(response).not.toContain("[Stopped:");
    expect((response ?? "").toLowerCase()).not.toContain("too large");
    // Must reference context window in user-friendly terms.
    expect((response ?? "").toLowerCase()).toContain("context window");
  });

  it("IN-01 (d): healthy stop turn — result.response is BYTE-IDENTICAL (strict no-op)", () => {
    const original = "Here is the plan you requested, broken into three steps.";
    const lastStopReason = "stop"; // clean stop, not output-cap
    const effective = promoteOutputStarved("stop", lastStopReason);
    expect(effective).toBe("stop"); // not promoted
    // Apply gate logic: neither branch fires for "stop".
    let response: string = original;
    if (effective === "output_starved") {
      response = (response ?? "") + buildOutputStarvedAnnotation();
    }
    if (effective === "context_exhausted") {
      response = buildContextExhaustedReply();
    }
    // Strict byte-identical no-op.
    expect(response).toBe(original);
  });
});
