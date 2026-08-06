// SPDX-License-Identifier: Apache-2.0
/**
 * Output-budget repair — the provider-side context clamp that silently starves
 * a turn's output allowance to a single token.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import {
  MIN_VIABLE_WIRE_OUTPUT_TOKENS,
  repairStarvedOutputBudget,
} from "./output-budget-repair.js";

const logger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
}) as unknown as Parameters<typeof repairStarvedOutputBudget>[0]["logger"];

/** A payload whose real input is small — repair has ample room to restore. */
const smallPayload = (maxTokens: number): Record<string, unknown> => ({
  max_tokens: maxTokens,
  system: [{ type: "text", text: "you are a helpful assistant" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
  tools: [{ name: "read", description: "read a file" }],
});

describe("repairStarvedOutputBudget", () => {
  it("restores a viable output budget when the SDK clamped the wire cap to 1", () => {
    // The exact live shape: the resolver asked for 32768, the SDK's own context
    // clamp floored max_tokens to MIN_MAX_TOKENS=1, so the model emitted a
    // single token and returned stop_reason=max_tokens.
    const payload = smallPayload(1);
    const log = logger();

    const verdict = repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      contextWindow: 200000,
      logger: log,
    });

    expect(verdict?.starved).toBe(true);
    expect(verdict?.wireMaxTokens).toBe(1);
    expect(verdict?.repairedTo).toBe(32768);
    expect(payload.max_tokens).toBe(32768);
  });

  it("names the wire cap and the intent in the warning, so the operator is not told to raise maxTokens", () => {
    const payload = smallPayload(1);
    const log = logger();

    repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      contextWindow: 200000,
      logger: log,
    });

    const warn = vi.mocked(log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      wireMaxTokens: 1,
      intendedMaxTokens: 32768,
      errorKind: "resource",
    });
    // The hint must point at the provider-side clamp, not at the agent's
    // maxTokens knob — raising that knob cannot lift a clamped wire cap.
    expect(String((fields as { hint?: unknown }).hint)).toContain("context");
    expect(String(msg)).toContain("output budget");
  });

  it("caps the repair at the real headroom rather than the requested intent", () => {
    const payload = smallPayload(1);

    const verdict = repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      // Only ~6k of window: headroom is far below the 32768 intent.
      contextWindow: 10000,
      logger: logger(),
    });

    expect(verdict?.repairedTo).toBeLessThan(32768);
    expect(verdict?.repairedTo).toBeGreaterThanOrEqual(MIN_VIABLE_WIRE_OUTPUT_TOKENS);
    expect(payload.max_tokens).toBe(verdict?.repairedTo);
  });

  it("declines to repair — and says so — when the input genuinely leaves no room", () => {
    // A payload whose own content fills the window: raising max_tokens here
    // would trade a 1-token reply for a provider 400. The turn must instead be
    // reported against the context knobs.
    const payload: Record<string, unknown> = {
      max_tokens: 1,
      system: [{ type: "text", text: "x".repeat(40000) }],
      messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(40000) }] }],
    };

    const log = logger();
    const verdict = repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      contextWindow: 20000,
      logger: log,
    });

    expect(verdict?.starved).toBe(true);
    expect(verdict?.repairedTo).toBeUndefined();
    // Unrepairable, so the wire value is left alone for the provider to reject
    // honestly rather than silently producing a one-token answer.
    expect(payload.max_tokens).toBe(1);
    const [fields] = vi.mocked(log.warn).mock.calls[0]!;
    expect(String((fields as { hint?: unknown }).hint)).toMatch(/compact|context/i);
  });

  it("is silent and non-mutating on a healthy wire cap", () => {
    const payload = smallPayload(32768);
    const log = logger();

    const verdict = repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      contextWindow: 200000,
      logger: log,
    });

    expect(verdict?.starved).toBe(false);
    expect(payload.max_tokens).toBe(32768);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it("ignores a payload carrying no numeric cap", () => {
    const payload: Record<string, unknown> = { messages: [] };
    expect(
      repairStarvedOutputBudget({ payload, contextWindow: 200000, logger: logger() }),
    ).toBeUndefined();
  });

  it("treats an unknown context window as unrepairable rather than guessing one", () => {
    const payload = smallPayload(1);
    const verdict = repairStarvedOutputBudget({
      payload,
      intendedMaxTokens: 32768,
      contextWindow: undefined,
      logger: logger(),
    });

    expect(verdict?.starved).toBe(true);
    expect(verdict?.repairedTo).toBeUndefined();
    expect(payload.max_tokens).toBe(1);
  });
});
