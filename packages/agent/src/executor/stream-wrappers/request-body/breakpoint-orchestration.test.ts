// SPDX-License-Identifier: Apache-2.0
/**
 * Focused tests for `runCacheBreakpointPhase` — the orchestrator that
 * coordinates system-prompt block injection, breakpoint budget tracking,
 * graph-context placement, and the Fix E (log-review) 1h cache anchor
 * for user messages carrying large stable UNTRUSTED_ blocks.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { runCacheBreakpointPhase } from "./breakpoint-orchestration.js";
import type { RequestBodyInjectorConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as ComisLogger;
}

function makeConfig(overrides: Partial<RequestBodyInjectorConfig> = {}): RequestBodyInjectorConfig {
  return {
    getCacheRetention: () => "short",
    sessionKey: { agentId: "a1", channelType: "telegram", channelId: "ch-1" } as never,
    cacheBreakpointStrategy: "default",
    promoteRecentZoneOnSlowCadence: false,
    ...overrides,
  } as RequestBodyInjectorConfig;
}

function makeResult(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    system: [{ type: "text", text: "base system prompt" }],
    tools: [],
    messages,
  };
}

// ---------------------------------------------------------------------------
// Fix E (log-review): 1h TTL upgrade for UNTRUSTED_ blocks
// ---------------------------------------------------------------------------

describe("runCacheBreakpointPhase — Fix E: UNTRUSTED_ block 1h cache anchor", () => {
  const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" };

  it("places { type: 'ephemeral', ttl: '1h' } on the last block of a user message containing <<<UNTRUSTED_", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Please summarize:" },
          { type: "text", text: "<<<UNTRUSTED_HTML>>>...32KB of link-understanding output...</UNTRUSTED_HTML>>>" },
        ],
      },
    ];
    const result = makeResult(messages);

    runCacheBreakpointPhase(result, model, makeConfig(), /* needsCacheBreakpoints */ true, /* effectiveSkipCacheWrite */ false, /* minTokens */ 0, makeLogger());

    // The user message at index 2 (which carries UNTRUSTED_) should have
    // a 1h cache anchor on its LAST block.
    const targetMsg = (result.messages as Array<Record<string, unknown>>)[2]!;
    const content = targetMsg.content as Array<Record<string, unknown>>;
    const lastBlock = content[content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does NOT fire when no UNTRUSTED_ marker is present (no extra cache anchor on user message)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Please summarize: just an ordinary user message, no UNTRUSTED_ marker." }],
      },
    ];
    const result = makeResult(messages);

    runCacheBreakpointPhase(result, model, makeConfig(), true, false, 0, makeLogger());

    // The user message at index 2 should NOT have the 1h anchor that Fix
    // E would have placed. (Other breakpoint stages may still place
    // markers on adjacent messages, but the UNTRUSTED_ path must be
    // a no-op here.)
    const targetMsg = (result.messages as Array<Record<string, unknown>>)[2]!;
    const content = targetMsg.content as Array<Record<string, unknown>>;
    const has1h = content.some((b) => {
      const cc = b.cache_control as { type?: string; ttl?: string } | undefined;
      return cc?.type === "ephemeral" && cc?.ttl === "1h";
    });
    expect(has1h).toBe(false);
  });

  it("upgrades an already-placed 5m cache_control to 1h on the UNTRUSTED_ message", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Please summarize:" },
          {
            type: "text",
            text: "<<<UNTRUSTED_HTML>>>...32KB...</UNTRUSTED_HTML>>>",
            cache_control: { type: "ephemeral" }, // pre-placed 5m TTL
          },
        ],
      },
    ];
    const result = makeResult(messages);

    runCacheBreakpointPhase(result, model, makeConfig(), true, false, 0, makeLogger());

    // The upgrade path: existing cache_control on the last block is replaced with the 1h anchor.
    const targetMsg = (result.messages as Array<Record<string, unknown>>)[2]!;
    const content = targetMsg.content as Array<Record<string, unknown>>;
    const lastBlock = content[content.length - 1]!;
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("skips when effectiveSkipCacheWrite is true (don't write under explicit skip)", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [{ type: "text", text: "summarize: <<<UNTRUSTED_HTML>>>...</UNTRUSTED_HTML>>>" }],
      },
    ];
    const result = makeResult(messages);

    runCacheBreakpointPhase(result, model, makeConfig(), true, /* effectiveSkipCacheWrite */ true, 0, makeLogger());

    const targetMsg = (result.messages as Array<Record<string, unknown>>)[2]!;
    const content = targetMsg.content as Array<Record<string, unknown>>;
    const lastBlock = content[content.length - 1]!;
    // When the caller is skipping writes, Fix E must respect that — no anchor.
    expect(lastBlock.cache_control).toBeUndefined();
  });
});
