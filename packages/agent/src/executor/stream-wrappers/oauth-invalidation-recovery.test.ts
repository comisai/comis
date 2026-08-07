// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ok, err, type Result } from "@comis/shared";
import type { ClockPort, ComisLogger } from "@comis/core";
import * as streamWrappers from "./index.js";
import { createMockLogger } from "./__test-helpers/index.js";

type RecoveryError = { code: string; hint?: string };
type RecoveryFactory = (deps: {
  clock: ClockPort;
  logger: ComisLogger;
  recoverCredential: (providerId: string) => Promise<Result<void, RecoveryError>>;
}) => (next: StreamFn) => StreamFn;

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai-codex",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
} as unknown as Model<"openai-responses">;

const context: Context = { messages: [], tools: [] };

function message(
  stopReason: "stop" | "error",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "recovered" }] : [],
    api: "openai-responses",
    provider: "openai-codex",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: 0,
  } as AssistantMessage;
}

function terminalStream(finalMessage: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (finalMessage.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: finalMessage });
  } else {
    stream.push({ type: "start", partial: finalMessage });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
  }
  stream.end(finalMessage);
  return stream;
}

function factory(): RecoveryFactory {
  const candidate = (
    streamWrappers as unknown as Record<string, unknown>
  ).createOAuthInvalidationRecovery;
  expect(typeof candidate).toBe("function");
  return candidate as RecoveryFactory;
}

function makeClock(): ClockPort {
  let now = 100;
  return {
    now: vi.fn(() => now++),
    date: vi.fn(() => new Date(0)),
  } as unknown as ClockPort;
}

async function collect(streamResult: ReturnType<StreamFn>) {
  const stream = await streamResult;
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

describe("OAuth invalidation stream recovery", () => {
  it("refreshes and replays once without exposing the rejected attempt", async () => {
    const invalidated = terminalStream(
      message("error", "Encountered invalidated oauth token for user, failing request"),
    );
    const recovered = terminalStream(message("stop"));
    const next = vi.fn()
      .mockReturnValueOnce(invalidated)
      .mockReturnValueOnce(recovered) as unknown as StreamFn;
    const recoverCredential = vi.fn(async () => ok(undefined));
    const wrapped = factory()({
      clock: makeClock(),
      logger: createMockLogger(),
      recoverCredential,
    })(next);

    const output = await collect(wrapped(model, context));

    expect(recoverCredential).toHaveBeenCalledTimes(1);
    expect(recoverCredential).toHaveBeenCalledWith("openai-codex");
    expect(next).toHaveBeenCalledTimes(2);
    expect(output.events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(output.result.stopReason).toBe("stop");
  });

  it("passes unrelated provider errors through without refreshing", async () => {
    const failure = message("error", "529 Overloaded");
    const next = vi.fn(() => terminalStream(failure)) as unknown as StreamFn;
    const recoverCredential = vi.fn(async () => ok(undefined));
    const wrapped = factory()({
      clock: makeClock(),
      logger: createMockLogger(),
      recoverCredential,
    })(next);

    const output = await collect(wrapped(model, context));

    expect(recoverCredential).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(output.events).toHaveLength(1);
    expect(output.result.errorMessage).toBe("529 Overloaded");
  });

  it("preserves the original auth error when credential refresh fails", async () => {
    const failure = message(
      "error",
      "Encountered invalidated oauth token for user, failing request",
    );
    const next = vi.fn(() => terminalStream(failure)) as unknown as StreamFn;
    const logger = createMockLogger();
    const recoverCredential = vi.fn(async () =>
      err({ code: "REFRESH_FAILED", hint: "run comis auth login" }),
    );
    const wrapped = factory()({ clock: makeClock(), logger, recoverCredential })(next);

    const output = await collect(wrapped(model, context));

    expect(next).toHaveBeenCalledTimes(1);
    expect(output.result.errorMessage).toContain("invalidated oauth token");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "auth",
        hint: "run comis auth login",
        recoveryCode: "REFRESH_FAILED",
      }),
      "OAuth credential recovery failed",
    );
  });

  it("never refreshes more than once when the replay is also rejected", async () => {
    const first = terminalStream(
      message("error", "Encountered invalidated oauth token for user, failing request"),
    );
    const second = terminalStream(
      message("error", "Encountered invalidated oauth token for user, failing request"),
    );
    const next = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second) as unknown as StreamFn;
    const recoverCredential = vi.fn(async () => ok(undefined));
    const wrapped = factory()({
      clock: makeClock(),
      logger: createMockLogger(),
      recoverCredential,
    })(next);

    const output = await collect(wrapped(model, context));

    expect(recoverCredential).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
    expect(output.result.stopReason).toBe("error");
  });
});
