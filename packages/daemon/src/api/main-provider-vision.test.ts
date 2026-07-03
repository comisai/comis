// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the vision bridge: createMainProviderVision().describeImage
 * — the completeSimple-over-multimodal vision seam that runs ONE bounded call on
 * the agent's MAIN model and reuses the main provider's creds.
 *
 * The LLM is MOCKED here (determinism — no API key, no provider call):
 * completeSimple returns a canned AssistantMessage, getModel a stub. The bridge
 * mirrors createDialecticSeam (memory-dialectic-seam.ts) with three deltas:
 * (1) the MAIN model; (2) a multimodal [text, image] user message; (3) it returns
 * a Result (text + costUsd) rather than abstaining. Failure branches return an
 * honest err carrying an ImageErrorKind — the bridge NEVER throws out, NEVER
 * misroutes, and NEVER logs the buffer / base64 / prompt / response body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

// Spy on the sanctioned-root abort timer so we can assert it is armed + cleared
// (the seam-family discipline). Keep every other @comis/core export real.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    systemSetTimeout: vi.fn((_cb: () => void, _ms: number) => {
      // Return an opaque handle; do NOT fire the callback (no real timer in the test).
      return Symbol("timer") as unknown as ReturnType<typeof setTimeout>;
    }),
    systemClearTimeout: vi.fn(),
  };
});

import { createMainProviderVision, VisionUnavailable } from "./main-provider-vision.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";

type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Build a canned pi-ai AssistantMessage envelope. */
function assistantMsg(opts: {
  text: string;
  costTotal?: number;
  totalTokens?: number;
  provider?: string;
  model?: string;
  stopReason?: StopReason;
}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text", text: opts.text }],
    api: "anthropic",
    provider: opts.provider ?? "anthropic",
    model: opts.model ?? "claude-x",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: opts.totalTokens ?? 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.costTotal ?? 0 },
    },
    stopReason: opts.stopReason ?? ("stop" as const),
    timestamp: 1_700_000_000_000,
  };
}

function makeLogger() {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

/** The deps a daemon would inject (resolveModel + the cred closures by value). */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const logger = makeLogger();
  return {
    resolveModel: vi.fn((_agentId: string) => ({ provider: "anthropic", modelId: "claude-x" })),
    resolveApiKey: vi.fn((_provider: string) => "test-key" as string | undefined),
    resolveCodexKey: vi.fn(async (_provider: string) => undefined as string | undefined),
    clock: { now: () => 1_700_000_000_000 },
    logger: logger as never,
    ...overrides,
  };
}

const PROMPT = "what is in this image?";
const PNG = Buffer.from("fake-png-bytes");

beforeEach(() => {
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("createMainProviderVision().describeImage", () => {
  it("returns a callable describeImage bridge built from the injected deps", () => {
    const bridge = createMainProviderVision(makeDeps() as never);
    expect(typeof bridge.describeImage).toBe("function");
  });

  it("happy path: maps the AssistantMessage onto ok({ text, provider, model, costUsd })", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      assistantMsg({ text: "a cat", costTotal: 0.002, provider: "anthropic", model: "claude-x" }),
    );
    const bridge = createMainProviderVision(makeDeps() as never);

    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value).toEqual({
      text: "a cat",
      provider: "anthropic",
      model: "claude-x",
      tokensUsed: 15,
      costUsd: 0.002,
    });
  });

  it("issues ONE bounded completeSimple with a MULTIMODAL [text, image] user message (the keystone)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      assistantMsg({ text: "ok" }),
    );
    const bridge = createMainProviderVision(makeDeps() as never);
    await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const call = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const ctx = call[1] as { messages: Array<{ role: string; content: unknown }> };
    const content = ctx.messages[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: PROMPT });
    expect(content[1]).toEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    // The ImageContent block carries base64 in `data` (NOT a bare string — the seam delta).
    expect(content[1].data).toBe(PNG.toString("base64"));
    // The bounded options: apiKey passed by value, maxTokens cap, and the abort signal.
    const opts = call[2] as { apiKey: string; maxTokens: number; signal: AbortSignal };
    expect(opts.apiKey).toBe("test-key");
    expect(typeof opts.maxTokens).toBe("number");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("costUsd is read from usage.cost.total; a model with total:0 yields costUsd:0 (optional, 0 valid)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      assistantMsg({ text: "local", costTotal: 0 }),
    );
    const bridge = createMainProviderVision(makeDeps() as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.costUsd).toBe(0);
  });

  it("non-stop stopReason → classified honest err with an ImageErrorKind (never throws out)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      assistantMsg({ text: "", stopReason: "length" }),
    );
    const bridge = createMainProviderVision(makeDeps() as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect(res.error).toBeInstanceOf(VisionUnavailable);
    expect((res.error as VisionUnavailable).errorKind).toBe("empty_response");
    expect(res.error.message.length).toBeGreaterThan(0);
  });

  it("a stream that RESOLVES with stopReason 'aborted' AFTER the timeout fired → classified timeout, NOT empty_response", async () => {
    // pi-ai's completeSimple → AssistantMessageEventStream.result() RESOLVES
    // (does not reject) on the abort event, with the AssistantMessage carrying
    // stopReason:"aborted" (event-stream.js:64-75). So when our AbortController
    // fires at timeoutMs, the SDK can resolve (not throw) — bypassing the
    // catch-block timeout path. Drive that exact ordering: the timeout callback
    // runs (arming the abort + the timedOut flag), THEN the stream resolves with
    // stopReason:"aborted". The classification MUST be `timeout`.
    let timeoutCb: (() => void) | undefined;
    (systemSetTimeout as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (cb: () => void, _ms: number) => {
        timeoutCb = cb;
        return Symbol("timer") as unknown as ReturnType<typeof setTimeout>;
      },
    );
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // The wall-clock timeout fires first (the call exceeded timeoutMs)…
      timeoutCb?.();
      // …then pi-ai resolves the stream with the aborted AssistantMessage.
      return assistantMsg({ text: "", stopReason: "aborted" });
    });
    const bridge = createMainProviderVision(makeDeps() as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect(res.error).toBeInstanceOf(VisionUnavailable);
    expect((res.error as VisionUnavailable).errorKind).toBe("timeout");
    expect(res.error.message).toMatch(/timed out|timeout/i);
  });

  it("a non-stop stream resolving 'aborted' WITHOUT the abort signal set is still classified by controller.signal (defensive)", async () => {
    // Belt-and-suspenders: if a provider ever resolves stopReason:"aborted"
    // and the controller IS aborted (the only abort trigger on this path is our
    // own timer), it is a timeout. This pins that `aborted` is read as a
    // timeout indicator on this branch, not a generic empty_response.
    let timeoutCb: (() => void) | undefined;
    (systemSetTimeout as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (cb: () => void, _ms: number) => {
        timeoutCb = cb;
        return Symbol("timer") as unknown as ReturnType<typeof setTimeout>;
      },
    );
    (completeSimple as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      timeoutCb?.();
      return assistantMsg({ text: "", stopReason: "aborted" });
    });
    const deps = makeDeps();
    const bridge = createMainProviderVision(deps as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect((res.error as VisionUnavailable).errorKind).toBe("timeout");
    // The content-free WARN reflects the timeout classification.
    const warnCall = deps.logger.warn.mock.calls.find(
      (c: unknown[]) => (c[0] as { step?: string } | undefined)?.step === "vision",
    );
    expect(warnCall).toBeDefined();
    expect((warnCall![0] as { imageErrorKind?: string }).imageErrorKind).toBe("timeout");
  });

  it("no creds (resolveApiKey undefined AND no codex key) → err(auth_required); completeSimple NEVER called", async () => {
    const deps = makeDeps({
      resolveApiKey: vi.fn(() => undefined),
      resolveCodexKey: vi.fn(async () => undefined),
    });
    const bridge = createMainProviderVision(deps as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect((res.error as VisionUnavailable).errorKind).toBe("auth_required");
    expect(res.error.message).toMatch(/API_KEY|key|codex|login/i);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("model resolution fails (getModel throws) → honest err; NEVER throws out", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unknown model");
    });
    const deps = makeDeps();
    const bridge = createMainProviderVision(deps as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect((res.error as VisionUnavailable).errorKind).toBe("unsupported_provider");
    expect(completeSimple).not.toHaveBeenCalled();
    // Non-fatal: warns counts/ids-only.
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("model resolution returns null → honest err; NEVER throws out", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const bridge = createMainProviderVision(makeDeps() as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected err");
    expect((res.error as VisionUnavailable).errorKind).toBe("unsupported_provider");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("codex cred path: provider openai-codex with no OPENAI_API_KEY still resolves via resolveCodexKey", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(assistantMsg({ text: "ok" }));
    const resolveCodexKey = vi.fn(async (_p: string) => "codex-bearer");
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({ provider: "openai-codex", modelId: "gpt-x" })),
      resolveApiKey: vi.fn(() => undefined), // no OPENAI_API_KEY in the secret store
      resolveCodexKey,
    });
    const bridge = createMainProviderVision(deps as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");

    expect(resolveCodexKey).toHaveBeenCalledWith("openai-codex");
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const opts = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[0][2] as { apiKey: string };
    expect(opts.apiKey).toBe("codex-bearer");
    expect(res.ok).toBe(true);
  });

  it("arms + clears the abort timer in finally on the SUCCESS path", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValueOnce(assistantMsg({ text: "ok" }));
    const bridge = createMainProviderVision(makeDeps() as never);
    await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(systemSetTimeout).toHaveBeenCalledTimes(1);
    expect(systemClearTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the abort timer in finally even when completeSimple THROWS, and returns honest err", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const bridge = createMainProviderVision(makeDeps() as never);
    const res = await bridge.describeImage(PNG, PROMPT, "image/png", "agent-1");
    expect(res.ok).toBe(false);
    expect(systemSetTimeout).toHaveBeenCalledTimes(1);
    expect(systemClearTimeout).toHaveBeenCalledTimes(1);
  });

  it("content-free logging: a failure NEVER logs the buffer / base64 / prompt / response text", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("provider exploded"));
    const deps = makeDeps();
    const bridge = createMainProviderVision(deps as never);
    await bridge.describeImage(PNG, "SENSITIVE-PROMPT-BODY", "image/png", "agent-1");

    expect(deps.logger.warn).toHaveBeenCalled();
    for (const callArgs of deps.logger.warn.mock.calls) {
      const serialized = JSON.stringify(callArgs);
      expect(serialized).not.toContain("SENSITIVE-PROMPT-BODY");
      expect(serialized).not.toContain(PNG.toString("base64"));
      expect(serialized).not.toContain("fake-png-bytes");
    }
    // The failure warn DOES carry the diagnostic fields.
    const [fields] = deps.logger.warn.mock.calls[0];
    expect(fields).toHaveProperty("agentId", "agent-1");
    expect(fields).toHaveProperty("errorKind");
    expect(fields).toHaveProperty("hint");
  });
});
