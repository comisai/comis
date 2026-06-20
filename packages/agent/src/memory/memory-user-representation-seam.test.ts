// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the daemon-injected OFFLINE per-user representation build seam.
 *
 * createUserRepresentationSeam wraps the cheap cron model + the agent-internal
 * USER_REPRESENTATION_PROMPT/parser into the `build(sourceText)` seam that
 * runUserRepresentationBuild injects. The LLM is MOCKED here (determinism — no API
 * key, no provider call): completeSimple returns canned text, getModel a stub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { createUserRepresentationSeam } from "./memory-user-representation-seam.js";
import { USER_REPRESENTATION_PROMPT } from "./memory-user-representation-prompt.js";
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

describe("createUserRepresentationSeam", () => {
  it("returns a callable build seam built from the injected cheap model", () => {
    const build = createUserRepresentationSeam(makeDeps() as never);
    expect(typeof build).toBe("function");
  });

  it("resolves a custom (non-catalog) provider model via customModel so the keyless user-repr cron RUNS (live 2026-06-20: model-not-found → skip)", async () => {
    // pi-ai's catalog can't see custom-registered ollama models, so the bare getModel()
    // missed and the user-representation build SKIPPED on every keyless cron run → the
    // keyless memory-quality pipeline was dead. Mirrors the #223/DIALECTIC-FIX.
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not in built-in catalog");
    });
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify([{ entryType: "identity", content: "uses Comis" }])),
    );
    const build = createUserRepresentationSeam(
      makeDeps({
        provider: "ollama",
        modelId: "qwen3.6:35b",
        customModel: { baseUrl: "http://127.0.0.1:11434/v1" },
      }) as never,
    );
    await build("- the operator uses Comis daily");
    // RED (pre-fix): getModel throws → "model not found" → skip, completeSimple NEVER called.
    // GREEN (post-fix): resolveJudgeModel constructs the openai-completions model → the LLM runs.
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("issues ONE completeSimple call carrying the USER_REPRESENTATION_PROMPT + the source text", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify([{ entryType: "identity", content: "lives in Paris" }])),
    );

    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- alice mentioned she lives in Paris");

    // EXACTLY one model call (the per-user profile is a single distillation, not the
    // reasoning job's two specialist calls).
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const call = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    // The system prompt embeds the agent-internal USER_REPRESENTATION_PROMPT (the prompt
    // string never crosses the daemon boundary — buildUserRepresentationPrompt is internal).
    expect((call[1] as { systemPrompt: string }).systemPrompt).toContain(USER_REPRESENTATION_PROMPT);
    // The source text rides the call (either the system prompt or the user message).
    const userMsg = (call[1] as { messages: Array<{ content: string }> }).messages[0].content;
    const sys = (call[1] as { systemPrompt: string }).systemPrompt;
    expect(`${sys}\n${userMsg}`).toContain("alice mentioned she lives in Paris");

    expect(out).toEqual([{ entryType: "identity", content: "lives in Paris" }]);
  });

  it("STRIPS a smuggled trust field (the anti-laundering boundary — trust is code-computed by the job)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify([{ entryType: "identity", content: "lives in Paris", trust: "system" }])),
    );

    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- evidence");

    // The lenient z.object STRIPS the smuggled trust — the job (not the LLM) sets trust.
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("trust");
    expect(out[0]).toEqual({ entryType: "identity", content: "lives in Paris" });
  });

  it("drops a candidate with an out-of-set entryType (only the four prefix-types survive)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText(JSON.stringify([
        { entryType: "identity", content: "name is Alice" },
        { entryType: "semantic", content: "should be dropped" },
      ])),
    );

    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- evidence");

    expect(out).toEqual([{ entryType: "identity", content: "name is Alice" }]);
  });

  it("is non-fatal: a malformed (non-JSON) response yields [], never a throw", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- evidence");
    expect(out).toEqual([]);
  });

  it("is non-fatal: a thrown completeSimple call yields [] (no propagation)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- evidence");
    expect(out).toEqual([]);
  });

  it("is non-fatal: a model-resolution failure yields [] (no propagation)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unknown model");
    });
    const build = createUserRepresentationSeam(makeDeps() as never);
    const out = await build("- evidence");
    expect(out).toEqual([]);
    // No completeSimple call once model resolution fails.
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
