// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  formatSessionKey,
  runWithContext,
  TypedEventBus,
  type SessionKey,
} from "@comis/core";
import { bindApiExecutionCancellation } from "./api-execution-cancellation.js";

const SESSION_KEY: SessionKey = {
  tenantId: "tenant",
  userId: "api",
  channelId: "request-a",
};

describe("API execution cancellation", () => {
  it("waits for exact run registration and ignores another request prompt", async () => {
    const eventBus = new TypedEventBus();
    const controller = new AbortController();
    const abort = vi.fn(async () => undefined);
    let registered = false;
    const resolveActiveSession = vi.fn(() => registered ? {
      abort,
      steer: vi.fn(),
      followUp: vi.fn(),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
    } : undefined);
    const cancellation = bindApiExecutionCancellation({
      signal: controller.signal,
      traceId: "request-trace",
      agentId: "agent-a",
      channelType: "openai",
      channelId: "request-a",
      sessionKey: SESSION_KEY,
      sessionResolver: {
        resolveActiveSession,
        hasActiveSession: vi.fn(),
      },
      eventBus,
      logger: { warn: vi.fn() },
    });

    controller.abort();
    await runWithContext({
      traceId: "other-trace",
      tenantId: "tenant",
      startedAt: 1,
      trustLevel: "user",
    }, async () => {
      eventBus.emit("prompt:submitted", {
        agentId: "agent-a",
        sessionKey: formatSessionKey(SESSION_KEY),
        traceId: "executor-trace-does-not-identify-request",
        promptChars: 1,
        provider: "test",
        modelId: "test",
        messageCount: 1,
        systemDigest: "a",
        messagesDigest: "b",
        timestamp: 1,
      });
    });
    expect(abort).not.toHaveBeenCalled();

    registered = true;
    await runWithContext({
      traceId: "request-trace",
      tenantId: "tenant",
      startedAt: 1,
      trustLevel: "user",
    }, async () => {
      eventBus.emit("prompt:submitted", {
        agentId: "agent-a",
        sessionKey: formatSessionKey(SESSION_KEY),
        traceId: "different-executor-trace",
        promptChars: 1,
        provider: "test",
        modelId: "test",
        messageCount: 1,
        systemDigest: "a",
        messagesDigest: "b",
        timestamp: 1,
      });
    });

    await cancellation.dispose();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(eventBus.listenerCount("prompt:submitted")).toBe(0);
  });

  it("rechecks for a run registered while the fallback listener is installed", async () => {
    const eventBus = new TypedEventBus();
    const controller = new AbortController();
    const abort = vi.fn(async () => undefined);
    let runVisible = false;
    const resolveActiveSession = vi.fn(() => runVisible ? {
      abort,
      steer: vi.fn(),
      followUp: vi.fn(),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
    } : undefined);
    const cancellation = bindApiExecutionCancellation({
      signal: controller.signal,
      traceId: "request-trace",
      agentId: "agent-a",
      channelType: "openai",
      channelId: "request-a",
      sessionKey: SESSION_KEY,
      sessionResolver: {
        resolveActiveSession,
        hasActiveSession: vi.fn(),
      },
      eventBus: {
        on: vi.fn((eventName, listener) => {
          runVisible = true;
          eventBus.on(eventName, listener);
        }),
        off: vi.fn((eventName, listener) => {
          eventBus.off(eventName, listener);
        }),
      },
      logger: { warn: vi.fn() },
    });

    controller.abort();
    await cancellation.dispose();

    expect(resolveActiveSession).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledOnce();
    expect(eventBus.listenerCount("prompt:submitted")).toBe(0);
  });

  it("rejects executor entry when the request was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancellation = bindApiExecutionCancellation({
      signal: controller.signal,
      traceId: "trace",
      agentId: "agent-a",
      channelType: "responses",
      channelId: "request-a",
      sessionKey: SESSION_KEY,
      sessionResolver: {
        resolveActiveSession: vi.fn(),
        hasActiveSession: vi.fn(),
      },
      eventBus: new TypedEventBus(),
      logger: { warn: vi.fn() },
    });

    expect(() => cancellation.throwIfAborted()).toThrow(
      "HTTP request was cancelled before agent execution completed",
    );
    await cancellation.dispose();
  });

  it("releases a request waiting in preparation as soon as cancellation arrives", async () => {
    const controller = new AbortController();
    const eventBus = new TypedEventBus();
    const cancellation = bindApiExecutionCancellation({
      signal: controller.signal,
      traceId: "trace",
      agentId: "agent-a",
      channelType: "openai",
      channelId: "request-a",
      sessionKey: SESSION_KEY,
      sessionResolver: {
        resolveActiveSession: vi.fn(),
        hasActiveSession: vi.fn(),
      },
      eventBus,
      logger: { warn: vi.fn() },
    });
    const preparation = new Promise<string>(() => undefined);
    const waiting = cancellation.waitFor(preparation);

    controller.abort("client disconnected");

    await expect(waiting).rejects.toThrow(
      "HTTP request was cancelled before agent execution completed",
    );
    await cancellation.dispose();
    expect(eventBus.listenerCount("prompt:submitted")).toBe(0);
  });

  it("bounds shutdown when the SDK abort promise never settles", async () => {
    const controller = new AbortController();
    const warn = vi.fn();
    const neverSettles = new Promise<void>(() => undefined);
    const cancellation = bindApiExecutionCancellation({
      signal: controller.signal,
      traceId: "trace",
      agentId: "agent-a",
      channelType: "responses",
      channelId: "request-a",
      sessionKey: SESSION_KEY,
      sessionResolver: {
        resolveActiveSession: vi.fn(() => ({
          abort: vi.fn(() => neverSettles),
          steer: vi.fn(),
          followUp: vi.fn(),
          isStreaming: vi.fn(() => true),
          isCompacting: vi.fn(() => false),
        })),
        hasActiveSession: vi.fn(),
      },
      eventBus: new TypedEventBus(),
      logger: { warn },
      abortSettleTimeoutMs: 5,
    });

    controller.abort("client disconnected");

    await expect(cancellation.dispose()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "timeout" }),
      expect.any(String),
    );
  });
});
