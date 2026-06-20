// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the daemon-injected query-time dialectic synthesis seam
 * (the ONE allowed query-time LLM surface).
 *
 * createDialecticSeam wraps a cheap resolved model + the agent-internal
 * DIALECTIC_PROMPT/parser into the `synthesize(question, groundingText)` seam the daemon's
 * memory.ask handler calls. The LLM is MOCKED here (determinism — no API key, no
 * provider call): completeSimple returns canned text, getModel a stub. The seam mirrors
 * createUserRepresentationSeam: ONE bounded call, abort-timer-cleared-in-finally, NON-FATAL
 * (any throw/abort/malformed/model-resolution failure degrades to { abstain: true } and
 * NEVER throws into recall). Logs are counts/ids-only — the question, grounding, and answer
 * text are NEVER in the log fields.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

// Spy on the sanctioned-root abort timer so we can assert it is always cleared (the
// seam-family discipline). Keep every other @comis/core export real.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    systemSetTimeout: vi.fn((cb: () => void, _ms: number) => {
      // Return an opaque handle; do NOT fire the callback (no real timer in the test).
      return Symbol("timer") as unknown as ReturnType<typeof setTimeout>;
    }),
    systemClearTimeout: vi.fn(),
  };
});

import { createDialecticSeam } from "./memory-dialectic-seam.js";
import { buildDialecticPrompt } from "./memory-dialectic-prompt.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";

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
    maxOutputTokens: 1024,
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

describe("createDialecticSeam", () => {
  it("returns a callable synthesize seam built from the injected cheap model", () => {
    const synthesize = createDialecticSeam(makeDeps() as never);
    expect(typeof synthesize).toBe("function");
  });

  it("resolves a custom (non-catalog) provider model via customModel spec so memory.ask runs keyless/local (live 2026-06-20: getModel('ollama','qwen3.6:35b')→not-found→abstain)", async () => {
    // pi-ai's catalog cannot see custom-registered ollama/lm-studio models, so the
    // bare getModel() missed and the dialectic abstained ("model not found") on EVERY
    // keyless memory.ask — even with a capable (mid+) model. Mirrors the #223 judge fix.
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not in built-in catalog");
    });
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText('{"answer":"MARLIN-30","citedIds":["id-1"]}'),
    );
    const synthesize = createDialecticSeam(
      makeDeps({
        provider: "ollama",
        modelId: "qwen3.6:35b",
        capabilityClass: "mid", // capable → NOT gated by the T-153 abstain
        customModel: { baseUrl: "http://127.0.0.1:11434/v1" },
      }) as never,
    );
    const out = await synthesize("what is my codename?", "[id-1] (recorded 2026-06-20) MARLIN-30");
    // RED (pre-fix): getModel throws → "model not found" → { abstain: true }, completeSimple NEVER called.
    // GREEN (post-fix): resolveJudgeModel constructs the openai-completions model from the spec → the LLM runs.
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ abstain: false });
  });

  it("issues EXACTLY ONE bounded completeSimple call (temperature 0, maxTokens, signal) and returns the grounded parse", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText('{"answer":"UTC","citedIds":["id-a"]}'),
    );

    const synthesize = createDialecticSeam(makeDeps() as never);
    const out = await synthesize("what timezone?", "[id-a] the timezone is UTC");

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const call = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    // The system prompt is the agent-internal DIALECTIC_PROMPT (never crosses the boundary —
    // the seam imports buildDialecticPrompt rather than embedding the string).
    expect((call[1] as { systemPrompt: string }).systemPrompt).toBe(buildDialecticPrompt());
    // The question + grounding ride the user message.
    const userMsg = (call[1] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userMsg).toContain("what timezone?");
    expect(userMsg).toContain("[id-a] the timezone is UTC");
    // Bounded + deterministic: temperature 0, the maxOutputTokens cap, and the abort signal.
    const opts = call[2] as { temperature: number; maxTokens: number; signal: AbortSignal };
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBe(1024);
    expect(opts.signal).toBeInstanceOf(AbortSignal);

    expect(out).toEqual({ abstain: false, answer: "UTC", citedIds: ["id-a"] });
  });

  it("is NON-FATAL: a thrown completeSimple call degrades to { abstain:true } and WARNs counts-only (no bodies)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const deps = makeDeps();
    const synthesize = createDialecticSeam(deps as never);

    const out = await synthesize("secret question text", "secret grounding text");
    expect(out).toEqual({ abstain: true });

    // A WARN with hint + errorKind, and NEVER the question / grounding / answer text.
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = deps.logger.warn.mock.calls[0];
    expect(fields).toMatchObject({ errorKind: "dependency" });
    expect(fields).toHaveProperty("hint");
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("secret question text");
    expect(serialized).not.toContain("secret grounding text");
  });

  it("clears the abort timer in finally on the SUCCESS path (the seam-family discipline)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText('{"answer":"UTC","citedIds":["id-a"]}'),
    );
    const synthesize = createDialecticSeam(makeDeps() as never);
    await synthesize("q", "g");

    expect(systemSetTimeout).toHaveBeenCalledTimes(1);
    expect(systemClearTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the abort timer in finally even when the LLM call THROWS", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const synthesize = createDialecticSeam(makeDeps() as never);
    await synthesize("q", "g");

    expect(systemSetTimeout).toHaveBeenCalledTimes(1);
    expect(systemClearTimeout).toHaveBeenCalledTimes(1);
  });

  it("degrades to { abstain:true } with a non-fatal WARN when getModel THROWS (model-resolution failure)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unknown model");
    });
    const deps = makeDeps();
    const synthesize = createDialecticSeam(deps as never);

    const out = await synthesize("q", "g");
    expect(out).toEqual({ abstain: true });
    // No completeSimple call once model resolution fails.
    expect(completeSimple).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("is NON-FATAL: a malformed (non-JSON) response degrades to { abstain:true }", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const synthesize = createDialecticSeam(makeDeps() as never);
    const out = await synthesize("q", "g");
    expect(out).toEqual({ abstain: true });
  });

  // R6 capability routing — T-153-fabricate mitigation
  it("R6: capabilityClass=nano without override returns { abstain:true } immediately (pre-call, no LLM invoked)", async () => {
    // Arrange: provide a canned LLM response — if the LLM IS called this would
    // return { abstain: false, answer: "x", citedIds: [] }; the test asserts
    // the seam abstains BEFORE reaching the LLM call.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText('{"answer":"x","citedIds":[]}'),
    );
    const deps = makeDeps({ capabilityClass: "nano" } as Record<string, unknown>);
    const synthesize = createDialecticSeam(deps as never);

    const out = await synthesize("q", "g");

    // Must return { abstain: true } — the capability-routing abstain.
    expect(out).toEqual({ abstain: true });
    // The LLM must NOT have been called (pre-call abort — the core T-153-fabricate guarantee).
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("R6: capabilityClass=nano with hasCapableModelOverride=true proceeds to the LLM (override honored)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      llmText('{"answer":"UTC","citedIds":["id-a"]}'),
    );
    const deps = makeDeps({
      capabilityClass: "nano",
      hasCapableModelOverride: true,
    } as Record<string, unknown>);
    const synthesize = createDialecticSeam(deps as never);

    const out = await synthesize("what timezone?", "[id-a] UTC");

    // Override → LLM IS called and the answer comes through.
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ abstain: false, answer: "UTC", citedIds: ["id-a"] });
  });

  it("R6: abstain message contains 'insufficient model capability' (explicit diagnostic, not generic)", async () => {
    // The abstain reason must carry the required diagnostic phrase so operators
    // can distinguish a capability-routing abstain from an LLM-failure abstain.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText('{"answer":"x","citedIds":[]}'),
    );
    const deps = makeDeps({ capabilityClass: "small" } as Record<string, unknown>);
    const synthesize = createDialecticSeam(deps as never);

    const out = await synthesize("q", "g");

    expect(out).toEqual({ abstain: true });
    // The seam must NOT call the LLM.
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
