/**
 * Shared test helpers for stream wrapper tests.
 * @module
 */

import { vi } from "vitest";
import type { Context, Message, AssistantMessage } from "@mariozechner/pi-ai";

export function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockStreamFn(): any {
  return vi.fn().mockReturnValue("stream-result");
}

export function makeAssistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5-20250929",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function makeContext(messages: Message[]): Context {
  return {
    systemPrompt: "test prompt",
    messages,
    tools: [],
  };
}
