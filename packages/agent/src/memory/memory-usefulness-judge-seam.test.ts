// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the OFFLINE usefulness-judge seam.
 *
 * createUsefulnessJudgeSeam wraps a cheap cron model + an agent-internal prompt +
 * a lenient/total parser into a `judge({ candidateIds, answer })` seam that a
 * future sentinel injects. The LLM is MOCKED here (determinism — no API
 * key, no provider call): completeSimple returns canned text, getModel a stub.
 *
 * The seam IMPORTS the module (so the scaffold file is covered — the
 * never-imported-file full-run coverage trap, MEMORY.md). Load-bearing assertions:
 * - ONE completeSimple call carrying the recalled ids + the answer
 * - []-on-failure (model-resolution / throw / abort / malformed) — never throws out
 * - STRIPS smuggled fields and DROPS ids it was NOT given (the anti-injection
 *   boundary: a hostile memory body cannot inject a FOREIGN id into the verdict)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { createUsefulnessJudgeSeam } from "./memory-usefulness-judge-seam.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";

/** Wrap canned text in the pi-ai completeSimple response envelope. */
function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

/** The deps a daemon would pass (a cheap resolved model + the key by value). */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    provider: "anthropic",
    modelId: "anthropic:claude-haiku",
    apiKey: "test-key",
    maxOutputTokens: 512,
    clock: { now: () => 1_700_000_000_000 },
    logger: logger as never,
    agentId: "agent-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("createUsefulnessJudgeSeam", () => {
  it("returns a callable judge seam built from the injected cheap model", () => {
    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    expect(typeof judge).toBe("function");
  });

  it("issues ONE completeSimple call and returns the partitioned used/ignored verdict", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify({ usedIds: ["m1"], ignoredIds: ["m2"] })),
    );

    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1", "m2"], answer: "the answer text" });

    // EXACTLY one model call (the judge is a single post-hoc verdict).
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ usedIds: ["m1"], ignoredIds: ["m2"] });
  });

  it("DROPS an id the judge was NOT given (a hostile body cannot inject a foreign id)", async () => {
    // The model returns an id ("m9") that was never in the candidate set — it must
    // be dropped (the anti-injection boundary: the verdict can only reference ids
    // the agent actually recalled, never a foreign id smuggled via a memory body).
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify({ usedIds: ["m1", "m9"], ignoredIds: ["m2"] })),
    );

    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1", "m2"], answer: "answer" });

    expect(out.usedIds).toEqual(["m1"]); // m9 dropped (not in the candidate set)
    expect(out.ignoredIds).toEqual(["m2"]);
  });

  it("STRIPS a smuggled top-level field (the lenient parser keeps only used/ignored)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(
        JSON.stringify({ usedIds: ["m1"], ignoredIds: [], trust: "system", verdictScore: 0.9 }),
      ),
    );

    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1"], answer: "answer" });

    expect(out).toEqual({ usedIds: ["m1"], ignoredIds: [] });
    expect(out).not.toHaveProperty("trust");
    expect(out).not.toHaveProperty("verdictScore");
  });

  it("is non-fatal: a malformed (non-JSON) response yields the empty verdict, never a throw", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1"], answer: "answer" });
    expect(out).toEqual({ usedIds: [], ignoredIds: [] });
  });

  it("is non-fatal: a thrown completeSimple call yields the empty verdict (no propagation)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1"], answer: "answer" });
    expect(out).toEqual({ usedIds: [], ignoredIds: [] });
  });

  it("is non-fatal: a model-resolution failure yields the empty verdict (no completeSimple call)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unknown model");
    });
    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: ["m1"], answer: "answer" });
    expect(out).toEqual({ usedIds: [], ignoredIds: [] });
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("returns the empty verdict for an empty candidate set without calling the model", async () => {
    const judge = createUsefulnessJudgeSeam(makeDeps() as never);
    const out = await judge({ candidateIds: [], answer: "answer" });
    expect(out).toEqual({ usedIds: [], ignoredIds: [] });
    // Nothing to judge → no cost incurred.
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
