// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the telegram lifecycle runner allowed_updates opt-in.
 *
 * Asserts that startLifecycle boots the grammy runner with an `allowed_updates`
 * list that includes "message_reaction" WITHOUT dropping any of the four
 * pre-existing updates the inbound binder already consumes (message,
 * edited_message, callback_query, poll). Omitting an existing update from
 * allowed_updates would silently stop delivering it.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before the SUT import.
// ---------------------------------------------------------------------------

const mockRun = vi.fn(() => ({ isRunning: () => true, stop: vi.fn() }));

vi.mock("@grammyjs/runner", () => ({
  run: (...args: unknown[]) => mockRun(...args),
}));

vi.mock("../credential-validator.js", () => ({
  validateBotToken: vi.fn(),
  validateWebhookSecret: vi.fn(),
}));

vi.mock("./telegram-inbound.js", () => ({
  bindInboundHandlers: vi.fn(),
}));

vi.mock("./telegram-webhook.js", () => ({
  shouldUseRunner: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { validateBotToken } from "../credential-validator.js";
import { startLifecycle } from "./telegram-lifecycle.js";
import type { TelegramAdapterDeps, TelegramAdapterState } from "./telegram-adapter-types.js";

function makeState(): TelegramAdapterState {
  return {
    bot: {
      api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
    } as unknown as TelegramAdapterState["bot"],
    handlers: [],
    reactionHandlers: [],
    channelId: "telegram-pending",
    runnerHandle: null,
    botIdentity: undefined,
    connected: false,
    startedAt: undefined,
    lastMessageAt: undefined,
    lastError: undefined,
  };
}

function makeDeps(): TelegramAdapterDeps {
  return { botToken: "test-bot-token", logger: createMockLogger() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startLifecycle -- runner allowed_updates opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBotToken).mockResolvedValue(ok({ id: 42, username: "testbot" }));
  });

  it("boots run() with allowed_updates including message_reaction AND all four pre-existing updates", async () => {
    const result = await startLifecycle(makeState(), makeDeps());
    expect(result.ok).toBe(true);

    expect(mockRun).toHaveBeenCalledTimes(1);
    const opts = mockRun.mock.calls[0]?.[1] as
      | { runner?: { fetch?: { allowed_updates?: string[] } } }
      | undefined;
    const allowed = opts?.runner?.fetch?.allowed_updates;
    expect(allowed).toBeDefined();
    // message_reaction MUST be present (the new opt-in)…
    expect(allowed).toContain("message_reaction");
    // …AND none of the existing updates may be silently dropped.
    expect(allowed).toContain("message");
    expect(allowed).toContain("edited_message");
    expect(allowed).toContain("callback_query");
    expect(allowed).toContain("poll");
  });
});
