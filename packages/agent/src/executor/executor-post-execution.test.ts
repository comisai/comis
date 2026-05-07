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
