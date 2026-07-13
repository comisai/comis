// SPDX-License-Identifier: Apache-2.0
/**
 * Prefix-stability diagnostic tests.
 *
 * Covers two behaviors added after the comis-harel cache-churn investigation
 * (2026-07-13):
 *  1. Diagnostic honesty — a divergence where the message ROLE changed
 *     (assistant→user) is a STRUCTURAL index-shift, not an in-place datetime
 *     edit; it must classify as "structural-shift" instead of being mislabeled
 *     "datetime-preamble" just because the current message carries the dynamic
 *     preamble string (which every historical user turn carries).
 *  2. Fleet plumbing — when the WARN fires, the `onPrefixUnstable` callback is
 *     invoked with a content-free payload so the daemon can emit the
 *     `agent:prefix_unstable` event that surfaces as a `comis fleet`
 *     cache_prefix_churn health signal.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyPrefixMutation, runPrefixStabilityDiagnostic } from "./prefix-stability.js";
import { sessionPrefixStability } from "./cache-breakpoints.js";
import type { RequestBodyInjectorConfig } from "./types.js";

function noopLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as never;
}

describe("classifyPrefixMutation — diagnostic honesty", () => {
  it("labels a ROLE CHANGE (assistant→user) as a structural index-shift, not datetime-preamble", () => {
    // The exact comis-harel sig: an empty assistant tool-use turn at an index
    // becomes a user turn carrying the dynamic preamble (which contains the
    // datetime string) — an index shift, not a datetime edit.
    const msg = { role: "user", content: [{ type: "text", text: "## Current Date & Time\n2026-07-13..." }] };
    const cls = classifyPrefixMutation(msg, "assistant|b1|t0|r0|len0", "user|b1|t0|r0|len6374");
    expect(cls).toContain("structural-shift");
    // It must NOT be reported as a plain datetime-preamble mutation (the misleading label).
    expect(cls).not.toBe("datetime-preamble");
  });

  it("still labels an in-place datetime edit (same role, small len change) as datetime-preamble", () => {
    const msg = { role: "user", content: [{ type: "text", text: "## Current Date & Time\n2026-07-13T06:10:00Z" }] };
    const cls = classifyPrefixMutation(msg, "user|b1|t0|r0|len40", "user|b1|t0|r0|len41");
    expect(cls).toContain("datetime-preamble");
    expect(cls).not.toContain("structural-shift");
  });

  it("still labels an in-place thinking-cleared mutation without a role change", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "answer" }] };
    const cls = classifyPrefixMutation(msg, "assistant|b2|t1|r0|len900", "assistant|b1|t0|r0|len100");
    expect(cls).toContain("thinking-cleared");
    expect(cls).not.toContain("structural-shift");
  });
});

describe("runPrefixStabilityDiagnostic — onPrefixUnstable fleet callback", () => {
  const sessionKey = "tenant:user:chan";

  beforeEach(() => {
    sessionPrefixStability.delete(sessionKey);
  });

  /** A request-body result whose message #1 is a stable user turn and #2 mutates. */
  function makeResult(msg2Role: string, msg2Text: string) {
    return {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "stable turn" }] },
        { role: msg2Role, content: [{ type: "text", text: msg2Text }] },
      ],
    } as Record<string, unknown>;
  }

  function makeConfig(onPrefixUnstable?: (p: unknown) => void): RequestBodyInjectorConfig {
    return {
      sessionKey,
      getCacheFenceIndex: () => 2, // fence covers indices 0..2 (all three messages)
      onPrefixUnstable,
    } as unknown as RequestBodyInjectorConfig;
  }

  it("fires onPrefixUnstable with a content-free payload once the mutation threshold is crossed", () => {
    const onPrefixUnstable = vi.fn();
    const logger = noopLogger();
    const config = makeConfig(onPrefixUnstable);

    // Baseline turn.
    runPrefixStabilityDiagnostic(makeResult("assistant", "turn A"), config, logger);
    // Three subsequent turns that each mutate message #2 in a cached region.
    runPrefixStabilityDiagnostic(makeResult("assistant", "turn B changed"), config, logger);
    runPrefixStabilityDiagnostic(makeResult("assistant", "turn C changed again"), config, logger);
    runPrefixStabilityDiagnostic(makeResult("assistant", "turn D changed more"), config, logger);

    expect(onPrefixUnstable).toHaveBeenCalled();
    const payload = onPrefixUnstable.mock.calls.at(-1)![0] as Record<string, unknown>;
    // Content-free: session key + structural counts/labels only, NO message text.
    expect(payload.sessionKey).toBe(sessionKey);
    expect(typeof payload.firstDivergentIndex).toBe("number");
    expect(typeof payload.cacheRegionMutations).toBe("number");
    expect(typeof payload.mutationClass).toBe("string");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("turn B changed");
    expect(serialized).not.toContain("turn C");
  });

  it("does NOT fire onPrefixUnstable when the prefix is byte-stable across turns", () => {
    const onPrefixUnstable = vi.fn();
    const logger = noopLogger();
    const config = makeConfig(onPrefixUnstable);

    const stable = () => makeResult("assistant", "identical turn");
    runPrefixStabilityDiagnostic(stable(), config, logger);
    runPrefixStabilityDiagnostic(stable(), config, logger);
    runPrefixStabilityDiagnostic(stable(), config, logger);
    runPrefixStabilityDiagnostic(stable(), config, logger);

    expect(onPrefixUnstable).not.toHaveBeenCalled();
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
  });
});
