// SPDX-License-Identifier: Apache-2.0
/**
 * `emitGenerationQuality` tests. The shared guarded emit helper for
 * `memory:generation_quality`: fires ONLY on a detected issue, is content-free,
 * carries the cron-job (no sessionKey) shape, and never throws out of a failing
 * subscriber (the emitSummaryLanguageMismatch isolation contract).
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { emitGenerationQuality } from "./emit-generation-quality.js";

function makeBus(): { bus: { emit: ReturnType<typeof vi.fn> }; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const bus = { emit };
  return { bus, emit };
}

const logger = { warn: vi.fn() };

describe("emitGenerationQuality", () => {
  it("emits memory:generation_quality on a non-Latin→Latin mismatch (the translation-regression class)", () => {
    const { bus, emit } = makeBus();
    emitGenerationQuality(bus, logger, {
      agentId: "default",
      pass: "user_representation",
      sourceText: "המשתמש גר בתל אביב ועובד בהייטק",
      outputText: "The user lives in Tel Aviv and works in tech",
      nowMs: 1000,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0]!;
    expect(event).toBe("memory:generation_quality");
    expect(payload).toMatchObject({
      agentId: "default",
      pass: "user_representation",
      sourceScript: "hebrew",
      outputScript: "latin",
      languageMismatch: true,
      emptyOutput: false,
      formatViolation: false,
      timestamp: 1000,
    });
    // Cron-job shape: no sessionKey key at all (not even undefined).
    expect("sessionKey" in (payload as object)).toBe(false);
  });

  it("is SILENT on a clean pass (script preserved, non-empty, parsed) — fleet count == regression count", () => {
    const { bus, emit } = makeBus();
    emitGenerationQuality(bus, logger, {
      agentId: "default",
      pass: "consolidation",
      sourceText: "המשתמש גר בתל אביב",
      outputText: "המשתמש גר בתל אביב ועובד בהייטק",
      nowMs: 1,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits on an empty output even when scripts would otherwise match", () => {
    const { bus, emit } = makeBus();
    emitGenerationQuality(bus, logger, {
      agentId: "a1",
      pass: "reasoning",
      sourceText: "the source",
      outputText: "   ",
      nowMs: 2,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toMatchObject({ emptyOutput: true, languageMismatch: false });
  });

  it("emits on a caller-supplied formatViolation even when the text classification is clean", () => {
    const { bus, emit } = makeBus();
    emitGenerationQuality(bus, logger, {
      agentId: "a1",
      pass: "consolidation",
      sourceText: "the source observations",
      outputText: "a perfectly fine latin observation",
      formatViolation: true,
      nowMs: 3,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toMatchObject({ formatViolation: true, languageMismatch: false, emptyOutput: false });
  });

  it("carries sessionKey only when supplied (session-bound caller)", () => {
    const { bus, emit } = makeBus();
    emitGenerationQuality(bus, logger, {
      agentId: "a1",
      sessionKey: "tenant:chan:peer",
      pass: "summary",
      sourceText: "שלום עולם",
      outputText: "hello world",
      nowMs: 4,
    });
    expect(emit.mock.calls[0]![1]).toMatchObject({ sessionKey: "tenant:chan:peer" });
  });

  it("never throws when the subscriber throws — generation is unaffected (guarded)", () => {
    const emit = vi.fn(() => {
      throw new Error("trajectory writer down");
    });
    const bus = { emit };
    const warn = vi.fn();
    expect(() =>
      emitGenerationQuality(bus, { warn }, {
        agentId: "a1",
        pass: "reasoning",
        sourceText: "שלום עולם",
        outputText: "hello world",
        nowMs: 5,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    // The WARN is content-free — no source/output body.
    const warnArg = JSON.stringify(warn.mock.calls[0]![0]);
    expect(warnArg).not.toContain("hello world");
    expect(warnArg).toContain("errorKind");
  });

  it("is a no-op when there is no event bus (optional bus)", () => {
    expect(() =>
      emitGenerationQuality(undefined, logger, {
        agentId: "a1",
        pass: "summary",
        sourceText: "שלום עולם",
        outputText: "hello world",
        nowMs: 6,
      }),
    ).not.toThrow();
  });
});
