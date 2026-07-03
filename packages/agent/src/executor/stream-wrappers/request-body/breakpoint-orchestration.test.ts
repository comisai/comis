// SPDX-License-Identifier: Apache-2.0
/**
 * Focused tests for `runCacheBreakpointPhase` — the orchestrator that
 * coordinates system-prompt block injection, breakpoint budget tracking,
 * graph-context placement, and the 1h cache anchor
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
// 1h TTL upgrade for UNTRUSTED_ blocks
// ---------------------------------------------------------------------------

describe("runCacheBreakpointPhase — UNTRUSTED_ block 1h cache anchor", () => {
  const model = { id: "claude-sonnet-4-5-20250929", provider: "anthropic" };

  it("places { type: 'ephemeral', ttl: '1h' } on the last block of a user message containing <<<UNTRUSTED_", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Please summarize:" },
          // LARGE untrusted block (the ~32KB link-understanding case the anchor exists for).
          // The anchor is size-gated, so the fixture must be genuinely large.
          { type: "text", text: "<<<UNTRUSTED_HTML>>>" + "x".repeat(20000) + "</UNTRUSTED_HTML>>>" },
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

    // The user message at index 2 should NOT have the 1h anchor that the
    // UNTRUSTED_ path would have placed. (Other breakpoint stages may still place
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

  it("does NOT anchor a SMALL untrusted block — frees the breakpoint slot for the lookback bridge", () => {
    // A small untrusted tool_result (e.g. an `echo` result) is cheap to re-upload and the SDK's
    // last-user marker already covers it. The anchor exists for LARGE blocks (~32KB); firing on a
    // small one steals the slot the lookback gap-bridge needs (the alternating-tool-turn gap).
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [{ type: "text", text: "<<<UNTRUSTED_TOOL>>>step-3\n<<</UNTRUSTED_TOOL>>>" }], // small (~40 chars)
      },
    ];
    const result = makeResult(messages);

    runCacheBreakpointPhase(result, model, makeConfig(), true, false, 0, makeLogger());

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
            text: "<<<UNTRUSTED_HTML>>>" + "x".repeat(20000) + "</UNTRUSTED_HTML>>>", // LARGE (passes the size gate)
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
    // When the caller is skipping writes, the UNTRUSTED_ anchor must respect that — no anchor.
    expect(lastBlock.cache_control).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Regression (live-observed): "1h cache_control block must not come
  // after a 5m cache_control block" when the UNTRUSTED_ anchor places 1h on the
  // LAST user message and placeCacheBreakpoints places 5m on the second-to-last.
  // -------------------------------------------------------------------------
  it("MONOTONIC-TTL: no 1h-after-5m violation when UNTRUSTED is on the last user message in a long conversation", () => {
    // Build an 11-message conversation (6 user + 5 assistant). The LAST
    // user message carries <<<UNTRUSTED_…>>>, triggering the anchor to place
    // 1h on it. With the anchor-aware retention coordination, the
    // recent-zone breakpoint that placeCacheBreakpoints lays down on
    // the second-to-last user message uses "long" retention instead of
    // "short" — preventing the live-observed ordering violation.
    // The monotonic-ttl safety-net sweep is the second layer of defense.
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 11; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      // Pad each message with enough text so placeCacheBreakpoints'
      // minTokens=0 path always treats the recent zone as eligible.
      const text = i === 10
        // Genuinely large (>16KB) so the UNTRUSTED size-gate fires and anchors a 1h marker
        // here (the precondition the monotonicity invariant exercises).
        ? `Please summarize: <<<UNTRUSTED_HTML>>>${"link-understanding output ".repeat(800)}<<<END_UNTRUSTED_HTML>>>`
        : `message ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit`;
      messages.push({ role, content: [{ type: "text", text }] });
    }
    const result = makeResult(messages);
    // resolvedRetention="long" so system block gets 1h cache_control —
    // this is the precondition for the live-observed violation shape.
    const config = makeConfig({ getCacheRetention: () => "long" });
    const logger = makeLogger();

    runCacheBreakpointPhase(result, model, config, true, false, 0, logger);

    // Collect every ephemeral cache_control marker in payload wire order
    // (tools -> system -> messages, each in array/content-block order).
    type Marker = { location: string; ttl: "1h" | "5m" };
    const markers: Marker[] = [];
    if (Array.isArray(result.tools)) {
      (result.tools as Array<Record<string, unknown>>).forEach((tool, ti) => {
        const cc = tool.cache_control as { type?: string; ttl?: string } | undefined;
        if (cc?.type === "ephemeral") {
          markers.push({ location: `tools[${ti}]`, ttl: cc.ttl === "1h" ? "1h" : "5m" });
        }
      });
    }
    if (Array.isArray(result.system)) {
      (result.system as Array<Record<string, unknown>>).forEach((blk, si) => {
        const cc = blk.cache_control as { type?: string; ttl?: string } | undefined;
        if (cc?.type === "ephemeral") {
          markers.push({ location: `system[${si}]`, ttl: cc.ttl === "1h" ? "1h" : "5m" });
        }
      });
    }
    (result.messages as Array<Record<string, unknown>>).forEach((msg, mi) => {
      const content = msg.content;
      if (!Array.isArray(content)) return;
      (content as Array<Record<string, unknown>>).forEach((blk, bi) => {
        const cc = blk.cache_control as { type?: string; ttl?: string } | undefined;
        if (cc?.type === "ephemeral") {
          markers.push({ location: `messages[${mi}].content[${bi}]`, ttl: cc.ttl === "1h" ? "1h" : "5m" });
        }
      });
    });

    // Sanity: at least one 1h marker exists (the UNTRUSTED_ anchor on
    // messages[10], plus the system block). Otherwise the test isn't
    // actually exercising the ordering invariant.
    const oneHourMarkers = markers.filter((m) => m.ttl === "1h");
    expect(oneHourMarkers.length).toBeGreaterThanOrEqual(2);

    // Monotonicity: walking backward, once we see a 1h marker, every
    // earlier marker MUST be 1h too. Equivalently, no 5m marker may
    // appear before any 1h marker in forward payload order.
    let seenOneHour = false;
    const violations: string[] = [];
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i]!;
      if (m.ttl === "1h") {
        seenOneHour = true;
        continue;
      }
      if (seenOneHour) {
        violations.push(`${m.location} is 5m but a 1h marker appears later in payload order`);
      }
    }
    expect(violations).toEqual([]);
  });
});
