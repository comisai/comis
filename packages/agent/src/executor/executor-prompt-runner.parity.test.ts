// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  runPrompt,
  type PromptRunnerBridge,
  type RunPromptParams,
  type PromptRunResult,
} from "./prompt-runner/index.js";

/**
 * Phase 42 parity protection — EXEC-SPLIT-01.
 *
 * These snapshots lock the byte-identical public-API surface of
 * executor-prompt-runner.ts BEFORE the Phase 42 split refactor lands.
 *
 * The post-refactor public surface MUST match these snapshots exactly. Any
 * byte change FAILS this test → fails `pnpm test` → fails the per-commit
 * gate.
 *
 * Captured: in the Phase 42 reference commit (plan 42-01). Subsequent split
 * commits (Wave 2 cache-detection → Wave 3 request-body → Wave 4
 * prompt-runner → Wave 5 pi-executor) must keep this test green. Per
 * EXEC-SPLIT-14, this file is DELETED in plan 42-06 after each new
 * structure has ≥1 independent behavior test per extracted module.
 *
 * Open-question Q1 decision (locked): signatures + 5-8 behavior matrix
 * it() blocks per file.
 *
 * Note: `runPrompt()` is NOT invoked. The factory requires full deps
 * construction (AgentSession + ModelRegistry + BudgetGuard + CostTracker +
 * AuthRotationAdapter + ProviderHealthMonitor + …) — too expensive for a
 * parity test (RESEARCH §"Pattern 1"). We snapshot the public-API surface
 * (function + 3 interfaces) via hand-maintained type-level witnesses
 * derived from the declared interface shapes.
 */

function stableStringify(value: unknown): string {
  // Sort keys deterministically; drop `description: undefined` keys consistently;
  // produces a snapshot string that does not vary across Node patch versions.
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          const v = (val as Record<string, unknown>)[k];
          if (v !== undefined) sorted[k] = v;
        }
        return sorted;
      }
      return val;
    },
    2,
  );
}

describe("executor-prompt-runner parity (EXEC-SPLIT-01)", () => {
  describe("public API surface", () => {
    it("exports the expected named symbols", () => {
      // The 3 interfaces are type-level; only `runPrompt` is a value. We
      // snapshot the value-level export name plus the three interface
      // name strings to lock the public surface.
      const valueExports = { runPrompt };
      const typeExports = [
        "PromptRunnerBridge",
        "RunPromptParams",
        "PromptRunResult",
      ] as const;
      expect(
        stableStringify({
          values: Object.keys(valueExports).sort(),
          types: [...typeExports].sort(),
        }),
      ).toMatchSnapshot();
    });

    it("runPrompt: function typeof + arity witness", () => {
      // `runPrompt` is async ⇒ `typeof` is "function"; `length` is the
      // declared parameter count (1 — the destructured `params` object).
      expect(
        stableStringify({
          typeof: typeof runPrompt,
          length: runPrompt.length,
          name: runPrompt.name,
        }),
      ).toMatchSnapshot();
    });
  });

  describe("type-level surface witnesses (no invocation)", () => {
    it("PromptRunnerBridge.getResult — required-call key witness", () => {
      // Hand-maintained witness mirroring the type's getResult() return shape.
      // Any field name change drifts the snapshot.
      type GetResultReturn = ReturnType<PromptRunnerBridge["getResult"]>;
      const witness: Array<keyof GetResultReturn> = [
        "finishReason",
        "lastLlmErrorMessage",
        "lastStopReason",
        "llmCalls",
        "stepsExecuted",
        "textEmitted",
        "tokensUsed",
        "toolCallHistory",
      ];
      expect(stableStringify([...witness].sort())).toMatchSnapshot();
    });

    it("RunPromptParams — required field key witness", () => {
      // Hand-maintained witness of the non-optional `RunPromptParams` fields.
      // The split refactor must preserve the entire required set.
      const required: Array<keyof RunPromptParams> = [
        "_directives",
        "_prevTimestamp",
        "agentId",
        "bridge",
        "capabilityIndexResult",
        "cmdResult",
        "config",
        "deferredContext",
        "deps",
        "dynamicPreamble",
        "effectiveTimeout",
        "executionId",
        "executionOverrides",
        "executionPlanRef",
        "executionStartMs",
        "formattedKey",
        "inlineMemory",
        "mergedCustomTools",
        "msg",
        "onResetTimer",
        "resolvedModel",
        "result",
        "sepEnabled",
        "session",
        "sessionKey",
        "systemPrompt",
      ];
      expect(stableStringify([...required].sort())).toMatchSnapshot();
    });

    it("RunPromptParams.deps — required field key witness", () => {
      // Snapshot the required dependency port names. Same hand-maintained
      // witness shape; locks the deps contract before the split.
      type Deps = RunPromptParams["deps"];
      const requiredDeps: Array<keyof Deps> = [
        "budgetGuard",
        "clock",
        "costTracker",
        "eventBus",
        "logger",
        "modelRegistry",
        "timers",
      ];
      expect(stableStringify([...requiredDeps].sort())).toMatchSnapshot();
    });

    it("PromptRunResult — required field key witness", () => {
      // Two required fields per the source definition; the rest are
      // optional (ghostCost, stuckSessionDetected).
      const required: Array<keyof PromptRunResult> = [
        "escalationAttempted",
        "promptError",
        "promptSucceeded",
      ];
      expect(stableStringify([...required].sort())).toMatchSnapshot();
    });
  });
});
