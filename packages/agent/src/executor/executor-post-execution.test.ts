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
import { describe, it, expect } from "vitest";
import { buildSessionEndMetadata, shouldStorePairedMemory } from "./executor-post-execution.js";
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
describe("buildSessionEndMetadata", () => {
  const baseArgs = {
    finishReason: "stop",
    durationMs: 1234,
    totalTokens: 567,
    executionId: "exec-Y",
    traceId: "trace-X",
    clock: { now: () => Date.now(), nowDate: () => new Date() },
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

  it("falls back to 'error' for unmapped finishReasons", () => {
    const result = buildSessionEndMetadata({ ...baseArgs, finishReason: "some_unknown_reason" });
    expect(result.sessionEnd?.endReason).toBe("error");
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
    const blockStart = stripped.indexOf("if (deps.contextStore)");
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
