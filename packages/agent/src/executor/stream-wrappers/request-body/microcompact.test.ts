// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the microcompact orchestration triggers.
 *
 * Focus: `runEveryTurnMicrocompact` (EFF-01/EFF-03) — the unconditional every-turn
 * Tier-0 microcompact pass that clears stale compactable tool results regardless of
 * the TTL-expiry / token-ceiling gates, fence-protected and cache-stable.
 *
 * The TTL/ceiling triggers (runTimeBasedMicrocompact / runTokenCeilingMicrocompact)
 * are exercised end-to-end via the onPayload pipeline in factory.test.ts.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { runEveryTurnMicrocompact } from "./microcompact.js";
import { createMockLogger } from "../__test-helpers/index.js";
import type { RequestBodyInjectorConfig } from "./types.js";

const STALE = "X".repeat(1500); // > MICROCOMPACT_MIN_CONTENT_LENGTH (1000)
const PLACEHOLDER = "[Stale tool result cleared: idle > TTL]";

/**
 * A result.messages array with `count` stale `read` tool_results, each preceded by
 * its assistant tool_use. Layout repeats [user, assistant(read tool_use), tool(read result)].
 * With keepWindow=1 only the LAST tool_result is protected; the rest are clearable.
 */
function messagesWithStaleReads(count: number): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `u${i}` }] });
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read", input: {} }] });
    msgs.push({ role: "tool", tool_use_id: `t${i}`, content: [{ type: "text", text: STALE }] });
  }
  return msgs;
}

/** A minimal config with the fields runEveryTurnMicrocompact reads. */
function makeConfig(overrides: Partial<RequestBodyInjectorConfig> = {}): RequestBodyInjectorConfig {
  return {
    sessionKey: "test-every-turn",
    observationKeepWindow: 1,
    ...overrides,
  } as unknown as RequestBodyInjectorConfig;
}

describe("runEveryTurnMicrocompact — EFF-01 (unconditional every-turn pass)", () => {
  it("clears stale compactable results with NO TTL/ceiling condition met", () => {
    // No getElapsedSinceLastResponse, no microcompactTokenCeiling — neither TTL nor
    // ceiling trigger would fire. The every-turn pass clears anyway.
    const onContentModification = vi.fn();
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({ onContentModification });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    const msgs = result.messages as Array<Record<string, unknown>>;
    // idx 2 and idx 5 are stale reads beyond the keepWindow=1 → cleared.
    expect((msgs[2]!.content as any[])[0].text).toBe(PLACEHOLDER);
    expect((msgs[5]!.content as any[])[0].text).toBe(PLACEHOLDER);
    // idx 8 is the last tool_result (within keepWindow) → preserved.
    expect((msgs[8]!.content as any[])[0].text).toBe(STALE);
    // It signals a deliberate content modification when it clears.
    expect(onContentModification).toHaveBeenCalled();
  });

  it("is a no-op (no onContentModification) when nothing is clearable", () => {
    const onContentModification = vi.fn();
    // Only one stale read → it is within keepWindow=1 → nothing to clear.
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(1) };
    const config = makeConfig({ onContentModification });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    expect((result.messages as any[])[2].content[0].text).toBe(STALE); // untouched
    expect(onContentModification).not.toHaveBeenCalled();
  });

  it("returns without touching messages when sessionKey is absent", () => {
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({ sessionKey: undefined });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    // No sessionKey → guard short-circuits → first stale read NOT cleared.
    expect((result.messages as any[])[2].content[0].text).toBe(STALE);
  });

  it("returns when result.messages is not an array", () => {
    const result: Record<string, unknown> = { messages: undefined };
    // Must not throw.
    expect(() => runEveryTurnMicrocompact(result, makeConfig(), createMockLogger())).not.toThrow();
  });
});

describe("runEveryTurnMicrocompact — EFF-03 (cache-stability)", () => {
  it("never clears a stale result at or below the cache fence", () => {
    // 3 stale reads at tool indices 2, 5, 8. Fence at 3 protects idx <= 3.
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({
      observationKeepWindow: 1,
      getCacheFenceIndex: () => 3, // protect messages 0..3
    });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    const msgs = result.messages as Array<Record<string, unknown>>;
    // idx 2: at/below fence (<=3) → PROTECTED, NOT cleared.
    expect((msgs[2]!.content as any[])[0].text).toBe(STALE);
    // idx 5: beyond fence AND beyond keepWindow → cleared.
    expect((msgs[5]!.content as any[])[0].text).toBe(PLACEHOLDER);
    // idx 8: within keepWindow → preserved.
    expect((msgs[8]!.content as any[])[0].text).toBe(STALE);
  });

  it("does NOT reset adaptive retention (warm-cache rule — mirrors runTokenCeilingMicrocompact)", () => {
    const onAdaptiveRetentionReset = vi.fn();
    const onContentModification = vi.fn();
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({ onAdaptiveRetentionReset, onContentModification });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    // It cleared (onContentModification fired) ...
    expect(onContentModification).toHaveBeenCalled();
    // ... but it must NEVER reset adaptive retention — the cache may still be warm.
    expect(onAdaptiveRetentionReset).not.toHaveBeenCalled();
  });
});
