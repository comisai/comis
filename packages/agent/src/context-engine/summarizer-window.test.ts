// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link resolveSummarizerWindowTokens} — THE one resolved-summarizer
 * window read (SUMW-01, Phase 178). Moved verbatim from
 * `lcd-leaf-summarizer.test.ts` alongside the production extraction (the
 * source file sat at the 800-line file-size cap).
 */
import { describe, it, expect } from "vitest";
import { resolveSummarizerWindowTokens } from "./summarizer-window.js";
import type { LeafSummarizerDeps } from "./lcd-leaf-summarizer.js";

// ===========================================================================
// SUMW-01 (Phase 178): resolveSummarizerWindowTokens — THE one resolved-
// summarizer window read. It must mirror buildLeafSummarizeFn's model
// resolution EXACTLY (`overrideModel?.model ?? getRealModel?.()`) so the span
// clamp and the LLM call can never disagree about WHICH model summarizes.
// Pitfall 2 (the override≠primary regression): `getModel()` is the session-
// PRIMARY snapshot — with an `operationModels.compaction` override the
// summarizer is a DIFFERENT model; a clamp keyed to the primary would pass a
// 131K span to an 8K summarizer (a provider overflow). Consumed by the
// pipeline clamp (llm-compaction) and the LCD leaf/condense clamps
// (plan 178-03 — interface-first: this plan defines, 03 consumes).
// ===========================================================================
describe("resolveSummarizerWindowTokens (SUMW-01)", () => {
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;

  it("override window WINS over the primary's window (the override≠primary regression — Pitfall 2)", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      overrideModel: {
        model: { id: "small-compaction-override", provider: "ollama", contextWindow: 8_000 },
        getApiKey: async () => "k",
      },
    });
    expect(win).toBe(8_000);
  });

  it("no override → the primary REAL model's window (getRealModel, not the snapshot)", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
    });
    expect(win).toBe(131_072);
  });

  it("resolved model with a missing/non-finite/non-positive contextWindow → snapshot fallback (never silently huge)", () => {
    const badWindows: unknown[] = [
      {}, // contextWindow absent entirely
      { contextWindow: Number.NaN },
      { contextWindow: 0 },
      { contextWindow: -1 },
      { contextWindow: Infinity },
      { contextWindow: "131072" }, // wrong type — string is not a window
    ];
    for (const model of badWindows) {
      const win = resolveSummarizerWindowTokens({
        getModel: () => ({ ...snapshot }),
        getRealModel: () => model,
      });
      expect(win).toBe(200_000); // the getModel() snapshot — the documented fallback
    }
  });

  it("getRealModel() returns undefined and no override → snapshot fallback", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => undefined,
    });
    expect(win).toBe(200_000);
  });

  it("deps WITHOUT getRealModel at runtime (trigger-test deps shape) → snapshot fallback, no TypeError", () => {
    // Production always sets getRealModel (executor-context-engine-setup.ts:394),
    // but dozens of pre-existing trigger-test deps builders omit it at runtime;
    // the helper's `getRealModel?.()` optional call must route them to the
    // documented snapshot fallback instead of a TypeError cascade.
    const deps = {
      getModel: () => ({ ...snapshot }),
    } as unknown as Pick<LeafSummarizerDeps, "overrideModel" | "getRealModel" | "getModel">;
    expect(resolveSummarizerWindowTokens(deps)).toBe(200_000);
  });

  it("override present but its model lacks contextWindow → snapshot fallback (override does NOT fall through to the primary)", () => {
    // The ?? chain resolves the MODEL first (override wins), THEN reads the
    // window — an override without a window must not silently adopt the
    // primary's (possibly huge) window. It degrades to the snapshot.
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      overrideModel: {
        model: { id: "windowless-override", provider: "groq" },
        getApiKey: async () => "k",
      },
    });
    expect(win).toBe(200_000);
  });
});
