// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the one-shot orchestrate repair seam.
 *
 * createOrchestrateRepairSeam wraps a resolved utility model + an internal
 * system prompt + a pure prompt builder + a fenced-script extractor into a
 * bounded `repair({script, language, stderrTail, describeDigest})` closure the
 * daemon injects into the orchestrate runner. On a recoverable non-zero exit the
 * runner calls it ONCE to regenerate the failed script; the seam issues exactly
 * one utility-model completion and returns the regenerated script (or undefined
 * when it cannot help).
 *
 * The completion is injected via an optional `completeFn` seam (default = the
 * real completeSimple) so the closure is macOS-unit-testable with no live model.
 * getModel is mocked so resolveJudgeModel resolves a stub model deterministically
 * (no pi-ai catalog dependency, no network).
 *
 * Load-bearing assertions:
 * - buildRepairPrompt is pure + deterministic and carries the stderr tail, the
 *   describe digest, and a "return ONLY the corrected script" instruction.
 * - extractScript pulls code out of a ```ts/```js/```py fence, returns the raw
 *   trimmed text when unfenced, and undefined for empty/whitespace-only text.
 * - the closure resolves a fenced corrected script → that script string.
 * - the closure degrades NON-FATALLY to undefined (never throws) on an empty /
 *   stopReason:"error" / thrown completion, and on a model-resolution failure.
 * - the closure passes apiKey + a bounded maxTokens + an abort signal to completeFn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { createOrchestrateRepairSeam, buildRepairPrompt, extractScript } from "./orchestrate-repair-seam.js";
import { getModel } from "@earendil-works/pi-ai/compat";

/** Wrap canned text in the pi-ai completeSimple response envelope. */
function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

/** The deps a daemon would pass (a resolved utility model + the key by value + the injected completion). */
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
    modelId: "claude-haiku",
    apiKey: "test-key",
    maxOutputTokens: 2048,
    clock: { now: () => 1_700_000_000_000 },
    logger: logger as never,
    agentId: "agent-1",
    ...overrides,
  };
}

const SAMPLE_INPUT = {
  script: "import { nope } from 'comis_tools';\nawait nope();",
  language: "ts" as const,
  stderrTail: "SyntaxError: The requested module 'comis_tools' does not provide an export named 'nope'",
  describeDigest: "comis_tools.web_search({query}) -> orch:web; comis_tools.read({path}) -> orch:read",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("buildRepairPrompt (pure)", () => {
  it("carries the stderr tail, the describe digest, and a return-ONLY-the-script instruction", () => {
    const prompt = buildRepairPrompt(SAMPLE_INPUT);
    expect(prompt).toContain(SAMPLE_INPUT.stderrTail);
    expect(prompt).toContain(SAMPLE_INPUT.describeDigest);
    expect(prompt).toContain(SAMPLE_INPUT.script);
    // A hard instruction to emit only the corrected code, no prose.
    expect(prompt.toLowerCase()).toContain("only");
    expect(prompt.toLowerCase()).toContain("script");
  });

  it("is deterministic — two calls on the same input are byte-equal (no clock/random)", () => {
    expect(buildRepairPrompt(SAMPLE_INPUT)).toBe(buildRepairPrompt(SAMPLE_INPUT));
  });
});

describe("extractScript (pure)", () => {
  it("pulls the code out of a ```ts fenced block", () => {
    const out = extractScript("Here is the fix:\n```ts\nconst x = 1;\nawait run(x);\n```\n");
    expect(out).toBe("const x = 1;\nawait run(x);");
  });

  it("pulls the code out of a ```js fenced block", () => {
    expect(extractScript("```js\nconsole.log(1);\n```")).toBe("console.log(1);");
  });

  it("pulls the code out of a ```py fenced block", () => {
    expect(extractScript("```py\nprint('hi')\n```")).toBe("print('hi')");
  });

  it("returns the raw trimmed text when there is no fence", () => {
    expect(extractScript("  const x = 1;  ")).toBe("const x = 1;");
  });

  it("returns undefined for empty text", () => {
    expect(extractScript("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(extractScript("   \n\t  ")).toBeUndefined();
  });
});

describe("createOrchestrateRepairSeam", () => {
  it("returns a callable repair seam built from the injected utility model", () => {
    const repair = createOrchestrateRepairSeam(makeDeps({ completeFn: vi.fn() }) as never);
    expect(typeof repair).toBe("function");
  });

  it("issues ONE completion and resolves the fenced corrected script", async () => {
    const completeFn = vi.fn().mockResolvedValueOnce(
      llmText("```ts\nimport comis_tools from 'comis_tools';\nawait comis_tools.web_search({ query: 'x' });\n```"),
    );
    const repair = createOrchestrateRepairSeam(makeDeps({ completeFn }) as never);
    const out = await repair(SAMPLE_INPUT);

    expect(completeFn).toHaveBeenCalledTimes(1);
    expect(out).toBe("import comis_tools from 'comis_tools';\nawait comis_tools.web_search({ query: 'x' });");
  });

  it("passes apiKey + a bounded maxTokens + an abort signal through to completeFn", async () => {
    const completeFn = vi.fn().mockResolvedValueOnce(llmText("```ts\nconst x = 1;\n```"));
    const repair = createOrchestrateRepairSeam(makeDeps({ completeFn, maxOutputTokens: 2048 }) as never);
    await repair(SAMPLE_INPUT);

    const opts = completeFn.mock.calls[0][2] as { apiKey?: string; maxTokens?: number; signal?: AbortSignal };
    expect(opts.apiKey).toBe("test-key");
    expect(opts.maxTokens).toBe(2048);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("is non-fatal: an empty-content completion yields undefined (never throws)", async () => {
    const completeFn = vi.fn().mockResolvedValueOnce({ content: [] });
    const repair = createOrchestrateRepairSeam(makeDeps({ completeFn }) as never);
    const out = await repair(SAMPLE_INPUT);
    expect(out).toBeUndefined();
  });

  it("is non-fatal: a pi-ai stopReason:'error' completion yields undefined + WARNs (content-free)", async () => {
    const completeFn = vi.fn().mockResolvedValueOnce({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '404 {"type":"error","error":{"message":"model not found"}}',
    });
    const deps = makeDeps({ completeFn });
    const repair = createOrchestrateRepairSeam(deps as never);
    const out = await repair(SAMPLE_INPUT);
    expect(out).toBeUndefined();
    expect((deps.logger as never as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("is non-fatal: a thrown completeFn yields undefined (no propagation) + WARNs", async () => {
    const completeFn = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const deps = makeDeps({ completeFn });
    const repair = createOrchestrateRepairSeam(deps as never);
    const out = await repair(SAMPLE_INPUT);
    expect(out).toBeUndefined();
    expect((deps.logger as never as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("is non-fatal: a model-resolution failure yields undefined + WARNs (no completion issued)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const completeFn = vi.fn();
    // No customModel + a catalog miss → resolveJudgeModel returns undefined.
    const deps = makeDeps({ completeFn, provider: "definitely-not-a-real-provider", modelId: "nope" });
    const repair = createOrchestrateRepairSeam(deps as never);
    const out = await repair(SAMPLE_INPUT);
    expect(out).toBeUndefined();
    expect(completeFn).not.toHaveBeenCalled();
    expect((deps.logger as never as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("never logs the script or the stderr tail (content-free failure logs — INV-5)", async () => {
    const completeFn = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const deps = makeDeps({ completeFn });
    const repair = createOrchestrateRepairSeam(deps as never);
    await repair({
      script: "SECRET_SCRIPT_BODY_DO_NOT_LOG",
      language: "ts",
      stderrTail: "SECRET_STDERR_TAIL_DO_NOT_LOG",
      describeDigest: "digest",
    });
    const logger = deps.logger as never as Record<string, ReturnType<typeof vi.fn>>;
    for (const level of ["info", "debug", "warn", "error"] as const) {
      for (const call of logger[level].mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain("SECRET_SCRIPT_BODY_DO_NOT_LOG");
        expect(serialized).not.toContain("SECRET_STDERR_TAIL_DO_NOT_LOG");
      }
    }
  });
});
