// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `upgradeSdkMarkers` — the SDK 5m → 1h cache_control
 * marker upgrade with the callCount gate.
 *
 * Tests cover:
 *  1. callCount gate suppresses promotion on first-turn writes (callCount=1)
 *  2. callCount gate allows promotion from turn 2 onward (callCount=2)
 *  3. callCount undefined skips the gate (promotion fires unconditionally)
 *  4. retention != "long" never promotes regardless of callCount
 *  5. skipCacheWrite suppresses promotion regardless of callCount
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "@comis/core";
import { upgradeSdkMarkers } from "./marker-upgrade.js";

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

/** Build a result-payload fixture with one ephemeral marker on a system block. */
function makeResultWithEphemeralSystemMarker(): Record<string, unknown> {
  return {
    system: [
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [
      {
        name: "exec",
        cache_control: { type: "ephemeral" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgradeSdkMarkers callCount gate", () => {
  it("does not promote 5m markers to 1h on the first turn when callCount is 1", () => {
    const result = makeResultWithEphemeralSystemMarker();
    const logger = makeLogger();

    upgradeSdkMarkers({
      result,
      modelId: "claude-sonnet-4-5",
      sessionKey: "test-session",
      resolvedRetention: "long",
      needsCacheBreakpoints: true,
      effectiveSkipCacheWrite: false,
      callCount: 1,
      logger,
    });

    // Marker stays at default 5m (no ttl field added).
    const systemBlock = (result.system as Array<Record<string, unknown>>)[0]!;
    const systemCc = systemBlock.cache_control as Record<string, unknown>;
    expect(systemCc.ttl).toBeUndefined();

    const toolBlock = (result.tools as Array<Record<string, unknown>>)[0]!;
    const toolCc = toolBlock.cache_control as Record<string, unknown>;
    expect(toolCc.ttl).toBeUndefined();
  });

  it("promotes 5m markers to 1h on the second turn when callCount is 2", () => {
    const result = makeResultWithEphemeralSystemMarker();
    const logger = makeLogger();

    upgradeSdkMarkers({
      result,
      modelId: "claude-sonnet-4-5",
      sessionKey: "test-session",
      resolvedRetention: "long",
      needsCacheBreakpoints: true,
      effectiveSkipCacheWrite: false,
      callCount: 2,
      logger,
    });

    const systemBlock = (result.system as Array<Record<string, unknown>>)[0]!;
    const systemCc = systemBlock.cache_control as Record<string, unknown>;
    expect(systemCc.ttl).toBe("1h");

    const toolBlock = (result.tools as Array<Record<string, unknown>>)[0]!;
    const toolCc = toolBlock.cache_control as Record<string, unknown>;
    expect(toolCc.ttl).toBe("1h");
  });

  it("skips the gate and promotes when callCount is undefined", () => {
    // When a caller does not thread callCount, the gate must be skipped —
    // silently disabling all promotions would be a production regression.
    const result = makeResultWithEphemeralSystemMarker();
    const logger = makeLogger();

    upgradeSdkMarkers({
      result,
      modelId: "claude-sonnet-4-5",
      sessionKey: "test-session",
      resolvedRetention: "long",
      needsCacheBreakpoints: true,
      effectiveSkipCacheWrite: false,
      logger,
    });

    const systemBlock = (result.system as Array<Record<string, unknown>>)[0]!;
    const systemCc = systemBlock.cache_control as Record<string, unknown>;
    expect(systemCc.ttl).toBe("1h");
  });

  it("does not promote when resolvedRetention is short regardless of callCount", () => {
    const result = makeResultWithEphemeralSystemMarker();
    const logger = makeLogger();

    upgradeSdkMarkers({
      result,
      modelId: "claude-sonnet-4-5",
      sessionKey: "test-session",
      resolvedRetention: "short",
      needsCacheBreakpoints: true,
      effectiveSkipCacheWrite: false,
      callCount: 10,
      logger,
    });

    const systemBlock = (result.system as Array<Record<string, unknown>>)[0]!;
    const systemCc = systemBlock.cache_control as Record<string, unknown>;
    expect(systemCc.ttl).toBeUndefined();
  });

  it("does not promote when effectiveSkipCacheWrite is true regardless of callCount", () => {
    const result = makeResultWithEphemeralSystemMarker();
    const logger = makeLogger();

    upgradeSdkMarkers({
      result,
      modelId: "claude-sonnet-4-5",
      sessionKey: "test-session",
      resolvedRetention: "long",
      needsCacheBreakpoints: true,
      effectiveSkipCacheWrite: true,
      callCount: 10,
      logger,
    });

    const systemBlock = (result.system as Array<Record<string, unknown>>)[0]!;
    const systemCc = systemBlock.cache_control as Record<string, unknown>;
    expect(systemCc.ttl).toBeUndefined();
  });
});
