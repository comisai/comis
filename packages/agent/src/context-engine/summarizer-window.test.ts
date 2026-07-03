// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link resolveSummarizerWindowTokens} — THE one resolved-summarizer
 * window read.
 */
import { describe, it, expect } from "vitest";
import { resolveSummarizerWindowTokens } from "./summarizer-window.js";
import type { LeafSummarizerDeps } from "./lcd-leaf-summarizer.js";

// ===========================================================================
// resolveSummarizerWindowTokens — THE one resolved-
// summarizer window read. It must mirror buildLeafSummarizeFn's model
// resolution EXACTLY (`overrideModel?.model ?? getRealModel?.()`) so the span
// clamp and the LLM call can never disagree about WHICH model summarizes.
// The override≠primary regression: `getModel()` is the session-
// PRIMARY snapshot — with an `operationModels.compaction` override the
// summarizer is a DIFFERENT model; a clamp keyed to the primary would pass a
// 131K span to an 8K summarizer (a provider overflow). Consumed by the
// pipeline clamp (llm-compaction) and the LCD leaf/condense clamps.
// ===========================================================================
describe("resolveSummarizerWindowTokens — model resolution (no served window)", () => {
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;

  it("override window WINS over the primary's window (the override≠primary regression)", () => {
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

// ===========================================================================
// The provider-SERVED window truth must reach this resolution. The flagship
// gap: a provider serving 8_192 against a configured 131_072 with the
// summarizer = the primary model —
// resolveSummarizerWindowTokens returned the configured 131_072, the
// leaf/condense clamps never bound, and a ~20K-token summarize input was
// dispatched to a provider serving 8K (silent input truncation of the summary
// source). The fix: each candidate model carries the served window that binds
// IT (`overrideModel.servedWindow` / `primaryServedWindow`), provider-gated at
// the wiring site against the probed `{providerKey, window}` pair,
// and the helper takes min(configured, served) for the candidate that
// actually summarizes. The model-resolution describe above is the no-served
// parity pin: every case there carries NO served field and must stay
// byte-identical.
// ===========================================================================
describe("resolveSummarizerWindowTokens — served-window truth", () => {
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;
  /** Wider-than-the-helper's-Pick deps shape (a typed variable, not a fresh
   *  literal, so excess-property checking cannot reject fields wider than the
   *  helper's parameter Pick). */
  type WindowDeps = Pick<
    LeafSummarizerDeps,
    "overrideModel" | "getRealModel" | "getModel" | "primaryServedWindow"
  >;

  it("flagship: a served-bound PRIMARY summarizer resolves min(configured, served) — configured 131_072 / served 8_192 → 8_192", () => {
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      primaryServedWindow: 8_192,
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(8_192);
  });

  it("provider scoping: an override on a DIFFERENT provider is NOT clamped by the primary provider's served window", () => {
    // operationModels.compaction → a cloud summarizer while the local primary
    // is served-bound at 8_192: the wiring site attaches NO servedWindow to the
    // override (provider mismatch), so the override's own window governs.
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      primaryServedWindow: 8_192,
      overrideModel: {
        model: { id: "cloud-summarizer", provider: "anthropic", contextWindow: 200_000 },
        getApiKey: async () => "k",
      },
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(200_000);
  });

  it("an override resolved onto the SAME served provider carries its own servedWindow and is clamped by it", () => {
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "anthropic", contextWindow: 200_000 }),
      overrideModel: {
        model: { id: "local-summarizer", provider: "ollama", contextWindow: 32_768 },
        getApiKey: async () => "k",
        servedWindow: 8_192,
      },
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(8_192);
  });

  it("min() direction: served LARGER than configured keeps the configured window (serving more never raises the window)", () => {
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      primaryServedWindow: 200_000,
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(131_072);
  });

  it("non-finite/non-positive served values are ignored (finite-positive guard) — configured governs", () => {
    for (const served of [0, -1, Number.NaN, Infinity]) {
      const deps: WindowDeps = {
        getModel: () => ({ ...snapshot }),
        getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
        primaryServedWindow: served,
      };
      expect(resolveSummarizerWindowTokens(deps)).toBe(131_072);
    }
  });

  it("served applies on the snapshot-fallback path too: a windowless primary model + served 8_192 → min(snapshot, served)", () => {
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "windowless-primary", provider: "ollama" }),
      primaryServedWindow: 8_192,
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(8_192);
  });

  it("served selection mirrors the ?? model resolution: overrideModel with a nullish model falls through to the PRIMARY served value, never the override's", () => {
    // The model resolution is `overrideModel?.model ?? getRealModel?.()` — when
    // the override's model is nullish the PRIMARY summarizes, so the primary's
    // served truth must bind (and the override's stale servedWindow must not).
    const deps: WindowDeps = {
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      primaryServedWindow: 8_192,
      overrideModel: {
        model: undefined,
        getApiKey: async () => "k",
        servedWindow: 99,
      },
    };
    expect(resolveSummarizerWindowTokens(deps)).toBe(8_192);
  });
});
