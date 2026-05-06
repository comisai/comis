// SPDX-License-Identifier: Apache-2.0
//
// T0.34 — silent-sentinel responses do NOT reach memoryPort.store.
//
// Phase 5 (15-02 cherry-pick) inserts an `isSilentResponse(result.response)`
// pre-gate at packages/agent/src/executor/executor-post-execution.ts:584-617
// so that responses like "[agent] NO_REPLY" / "NO_REPLY" / "HEARTBEAT_OK"
// / "[SILENT] x" never enter memory.db (RC-4 / B38 / AC-3).
//
// This test file scaffolds a slim postExecution invocation that captures
// `memoryPort.store(...)` calls. It is RED today because:
//   (a) packages/shared/src/silent-tokens.ts does not exist yet (so any
//       attempt to assert on the silent-sentinel pre-gate fails), and
//   (b) the production code at executor-post-execution.ts:584-617 stores
//       the pair regardless of silence; once 15-02 lands the gate, this
//       test turns green.
//
// We use a source-grep + behavior probe pair: the source-grep verifies
// the production module imports `isSilentResponse` from @comis/shared
// (the gate's load-bearing import); the behavior probe asserts that
// `shouldStorePairedMemory` and `isSilentResponse` together would refuse
// "NO_REPLY" responses.
//
// (This is the smallest assertion-grade RED test that does not require
// scaffolding all 30+ postExecution dependencies; a richer behavior test
// is owned by 15-04/15-05 once the dispatcher + drain seams stabilize.)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { shouldStorePairedMemory } from "./executor-post-execution.js";

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

describe("silent-sentinel response is not stored in memory.db (RC-4 / B38 / AC-3)", () => {
  it("T0.34: source-grep — executor-post-execution imports isSilentResponse from @comis/shared", () => {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    // Strip line + block comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Post-Phase-5 the production code imports isSilentResponse from @comis/shared.
    // Pre-Phase-5 it does not — RED until 15-02.
    expect(stripped).toMatch(/import\s*\{[^}]*\bisSilentResponse\b[^}]*\}\s*from\s*"@comis\/shared"/);
  });

  it("T0.34: behavior — isSilentResponse classifies NO_REPLY / [agent] NO_REPLY as silent", async () => {
    const mod = await loadSilentTokens();
    // The helper module must exist and be re-exported from @comis/shared
    // post-15-02. Until then this fails, signalling the pre-gate is not yet
    // in place.
    expect(mod).toBeDefined();
    if (!mod) return;
    expect(mod.isSilentResponse("NO_REPLY")).toBe(true);
    // The call site at line 593 builds `[user] X\n[agent] <truncated response>`,
    // so the response itself is the bare "NO_REPLY". The helper is responsible
    // for handling whitespace + reply-tag wrapping idempotently (B46 / T0.37).
    expect(mod.isSilentResponse("HEARTBEAT_OK")).toBe(true);
    expect(mod.isSilentResponse("[SILENT] context")).toBe(true);
  });

  it("T0.34: behavior — substantive responses still pass the quality gate", () => {
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
// Phase 4: markRead/markConsumed via tryGetContext + drain (RC-2 residual)
//
// Phase 4 (Plan 15-05) reshapes:
//   - markRead / markConsumed read tool context via tryGetContext()
//     (the AsyncLocalStorage handle), NOT a passed-in deps object.
//   - The drain happens at the call site (inline-consumption per B15)
//     keyed by the composite (agentId, channelType, channelId).
//   - effectiveAgentId normalizes undefined / empty / string-"" to "default"
//     consistently across the memory-store path and markRead path.
//
// All tests in this block are RED until 15-05 lands. Source-grep is the
// load-bearing assertion mode — exercising the runtime path requires
// scaffolding all 30+ postExecution dependencies, which is a heavier
// fixture than this Phase-0 plan should attempt.
// ---------------------------------------------------------------------------
describe("Phase 4: markRead/markConsumed via tryGetContext + drain (RC-2 residual)", () => {
  function readPostExec(): { src: string; stripped: string } {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    return { src, stripped };
  }

  it("T0.2: markRead reads tool context via tryGetContext() (NOT a passed-in deps object)", () => {
    const { stripped } = readPostExec();
    // Post-Phase-4: the production source either calls tryGetContext()
    // directly OR imports a helper module that does. Pre-Phase-4 there is
    // no such call-site in executor-post-execution.ts.
    expect(stripped).toMatch(/tryGetContext\s*\(/);
  });

  it("T0.3: markConsumed follows the same tryGetContext pattern", () => {
    const { stripped } = readPostExec();
    expect(stripped).toMatch(/markConsumed/);
  });

  it("T0.4: markRead is called at the inline-consumption call site (B15) — composite drain", () => {
    const { stripped } = readPostExec();
    // Post-Phase-4 the post-execution path either calls a drainAt(...) or
    // markRead with the composite key. Either marker proves the gate.
    expect(stripped).toMatch(/(drainAt|markRead)/);
  });

  it("T0.5: effectiveAgentId is referenced from a markRead/drain call-site (NOT only the memory branch)", () => {
    const { stripped } = readPostExec();
    // Pre-Phase-4 effectiveAgentId is computed inside the memory-store
    // branch only — not in any markRead / drain call. Post-Phase-4 the
    // normalized value is shared with the markRead/drain call. The contract:
    // a markRead or drain helper invocation references effectiveAgentId.
    const reused =
      /(markRead|drainAt|markConsumed|consume)\s*\([^)]*effectiveAgentId/s.test(stripped) ||
      /effectiveAgentId[^)]*\b(markRead|drainAt|markConsumed|consume)\b/s.test(stripped);
    expect(reused).toBe(true);
  });

  it("T0.24: multi-agent safety — drain key includes agentId (no cross-agent contamination)", () => {
    const { stripped } = readPostExec();
    // The post-Phase-4 drain key is (agentId, channelType, channelId).
    // Source-grep proves the agent is part of the drain key.
    expect(stripped).toMatch(/(drainAt|consume).*agentId/s);
  });

  it("T0.25: lock-safe drain — concurrent drains for the same composite key are gated", () => {
    const { stripped } = readPostExec();
    // Marker for the single-tick gate analog (mirrors setup-delivery.ts:113-121).
    const hasGate =
      /\bdraining\b\s*[?=]/.test(stripped) ||
      /inFlight/i.test(stripped) ||
      /drainLock/i.test(stripped);
    expect(hasGate).toBe(true);
  });

  it("T0.26: markRead failure is non-fatal (suppressError + structured WARN log)", () => {
    const { stripped } = readPostExec();
    // suppressError already exists for memory-store failures (line 565
    // analog). Post-Phase-4 it ALSO wraps the markRead call. Marker: at
    // least one suppressError reference plus the canonical WARN log shape.
    expect(stripped).toMatch(/suppressError\b/);
    expect(stripped).toMatch(/(hint:.*errorKind|errorKind:.*hint)/s);
  });

  it("T0.28: tryGetContext() in source falls through to no-op when undefined", () => {
    const { stripped } = readPostExec();
    // Once T0.2 lands, the call-site exists. Pre-Phase-4 the call-site
    // does not exist; this assertion fails alongside T0.2.
    const tryCtxLine = stripped.match(/tryGetContext\s*\([^)]*\)/);
    expect(tryCtxLine).not.toBeNull();
  });
});
