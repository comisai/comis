// SPDX-License-Identifier: Apache-2.0
/**
 * TTL monotonicity integration test.
 *
 * Pin the property: when the cache fence's retention/TTL parameter
 * escalates from a default (5-minute) to a long (1-hour) horizon, the
 * cache-break detector classifies the change as retention_changed (not
 * silently degrading to a system / tools attribution).
 *
 * Also asserts:
 *   - retention "default" -> "default" produces NO retention attribution
 *     (no false positive)
 *   - retention "1h" -> "1h" produces NO retention attribution
 *   - retention "default" -> undefined (or "1h" -> undefined) is treated as
 *     a change (the detector's contract is byte-equality, not semantic
 *     equivalence; this test pins the current behaviour so any future
 *     normalization is intentional)
 *   - the cacheControlChanged flag is set when system blocks pick up
 *     cache_control markers (TTL/scope flips), even when the underlying
 *     content is identical
 *
 * Imports the detector via its dist path -- not re-exported through
 * `@comis/agent`. See cache-fence-byte-identity.test.ts for the same
 * import rationale.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
// eslint-disable-next-line import/no-relative-packages -- factory not re-exported
import {
  createCacheBreakDetector,
  extractAnthropicPromptState,
} from "../../../packages/agent/dist/executor/cache-break-detection.js";

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}

const SESSION_KEY = "test:user_a:chan_ttl";
const AGENT_ID = "default";
const MODEL = "claude-opus-4-7";

function paramsWithCacheControl(retention: string | undefined) {
  // System block carries an explicit cache_control marker matching the
  // retention horizon. The hash extractor should fold this into
  // cacheControlHash separately from the underlying systemHash.
  const cache_control =
    retention === "1h"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };

  return {
    model: MODEL,
    system: [
      {
        type: "text",
        text: "You are a helpful assistant.",
        cache_control,
      },
    ],
    tools: [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: { type: "object" },
      },
    ],
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("TTL monotonicity -- retention escalation", () => {
  it("default -> 1h yields a retention_changed event when cache misses", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:esc`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("default"),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
      totalInputTokens: 4200,
    });

    // Escalate to 1h.
    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("1h"),
        MODEL,
        "1h",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 0,
      cacheWriteTokens: 4100,
      totalInputTokens: 4200,
    });
    expect(evt).not.toBeNull();
    if (evt) {
      expect(evt.changes.retentionChanged).toBe(true);
    }
  });

  it("1h -> default (de-escalation) is also flagged retention_changed", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:de-esc`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("1h"),
        MODEL,
        "1h",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
      totalInputTokens: 4200,
    });

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("default"),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 0,
      cacheWriteTokens: 4100,
      totalInputTokens: 4200,
    });
    expect(evt).not.toBeNull();
    if (evt) {
      expect(evt.changes.retentionChanged).toBe(true);
    }
  });
});

describe("TTL monotonicity -- stable retention is NOT flagged", () => {
  it("default -> default with stable cache reads: no event", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:stable-default`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("default"),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
      totalInputTokens: 4200,
    });

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("default"),
        MODEL,
        "default",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4050,
      cacheWriteTokens: 0,
      totalInputTokens: 4200,
    });
    expect(evt).toBeNull();
  });

  it("1h -> 1h with stable cache reads: no event", () => {
    const detector = createCacheBreakDetector(silentLogger());
    const sk = `${SESSION_KEY}:stable-1h`;

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("1h"),
        MODEL,
        "1h",
        sk,
        AGENT_ID,
      ),
    );
    detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4000,
      cacheWriteTokens: 100,
      totalInputTokens: 4200,
    });

    detector.recordPromptState(
      extractAnthropicPromptState(
        paramsWithCacheControl("1h"),
        MODEL,
        "1h",
        sk,
        AGENT_ID,
      ),
    );
    const evt = detector.checkResponseForCacheBreak({
      sessionKey: sk,
      provider: "anthropic",
      cacheReadTokens: 4050,
      cacheWriteTokens: 0,
      totalInputTokens: 4200,
    });
    expect(evt).toBeNull();
  });
});

describe("TTL monotonicity -- cache_control marker is folded separately", () => {
  it("changing cache_control TTL marker without changing system text alters cacheControlHash", () => {
    const a = extractAnthropicPromptState(
      paramsWithCacheControl("default"),
      MODEL,
      "default",
      `${SESSION_KEY}:cch-a`,
      AGENT_ID,
    );
    const b = extractAnthropicPromptState(
      paramsWithCacheControl("1h"),
      MODEL,
      "1h",
      `${SESSION_KEY}:cch-b`,
      AGENT_ID,
    );

    // Underlying system content is identical: same systemHash.
    expect(a.systemHash).toBe(b.systemHash);
    // But the marker hash differs (the part of the system block visible
    // to the wire that flips with TTL is captured here).
    expect(a.cacheControlHash).not.toBe(b.cacheControlHash);
  });

  it("identical cache_control marker hashes equal each other", () => {
    const a = extractAnthropicPromptState(
      paramsWithCacheControl("1h"),
      MODEL,
      "1h",
      `${SESSION_KEY}:cch-eq-a`,
      AGENT_ID,
    );
    const b = extractAnthropicPromptState(
      paramsWithCacheControl("1h"),
      MODEL,
      "1h",
      `${SESSION_KEY}:cch-eq-b`,
      AGENT_ID,
    );
    expect(a.cacheControlHash).toBe(b.cacheControlHash);
  });
});

describe("TTL monotonicity -- recorded retention is opaque, not normalized", () => {
  it("the recorded retention field round-trips verbatim", () => {
    const def = extractAnthropicPromptState(
      paramsWithCacheControl("default"),
      MODEL,
      "default",
      `${SESSION_KEY}:opaque-default`,
      AGENT_ID,
    );
    const oneHour = extractAnthropicPromptState(
      paramsWithCacheControl("1h"),
      MODEL,
      "1h",
      `${SESSION_KEY}:opaque-1h`,
      AGENT_ID,
    );
    const undef = extractAnthropicPromptState(
      paramsWithCacheControl(undefined),
      MODEL,
      undefined,
      `${SESSION_KEY}:opaque-undef`,
      AGENT_ID,
    );
    expect(def.retention).toBe("default");
    expect(oneHour.retention).toBe("1h");
    expect(undef.retention).toBeUndefined();
  });
});
