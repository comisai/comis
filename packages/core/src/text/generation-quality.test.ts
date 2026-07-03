// SPDX-License-Identifier: Apache-2.0
/**
 * `classifyGenerationQuality` tests. The pure, single-source
 * generation-quality classifier over a (source, output) text pair, generalizing
 * the `dominantScript(source) vs dominantScript(output)` check from
 * summaries to every memory-generation pass (consolidation / reasoning /
 * user-representation). VISIBILITY ONLY — pure function, no gating, no I/O.
 * @module
 */
import { describe, it, expect } from "vitest";
import { classifyGenerationQuality } from "./generation-quality.js";

describe("classifyGenerationQuality", () => {
  it("flags a non-Latin source whose output came back Latin (silent translation)", () => {
    // The regression class: a user-representation pass translating Hebrew facts into English.
    const c = classifyGenerationQuality("המשתמש גר בתל אביב ועובד בהייטק", "The user lives in Tel Aviv and works in tech");
    expect(c.sourceScript).toBe("hebrew");
    expect(c.outputScript).toBe("latin");
    expect(c.languageMismatch).toBe(true);
    expect(c.emptyOutput).toBe(false);
  });

  it("does NOT flag when the output preserved the source script", () => {
    const c = classifyGenerationQuality("המשתמש גר בתל אביב", "המשתמש גר בתל אביב ועובד בהייטק");
    expect(c.sourceScript).toBe("hebrew");
    expect(c.outputScript).toBe("hebrew");
    expect(c.languageMismatch).toBe(false);
  });

  it("never flags a Latin source (Latin → Latin is the healthy case)", () => {
    const c = classifyGenerationQuality("The user lives in Tel Aviv", "User: lives in Tel Aviv, works in tech");
    expect(c.sourceScript).toBe("latin");
    expect(c.languageMismatch).toBe(false);
    expect(c.emptyOutput).toBe(false);
  });

  it("a code-heavy (Latin-skewed) non-Latin source is NOT a mismatch (the 0.3 dominance tolerance)", () => {
    // A mixed code-heavy chunk legitimately skews Latin via the 0.3 threshold in
    // dominantScript — the classifier must not over-fire, which is why it never gates.
    const c = classifyGenerationQuality("install docker compose up --build", "run docker compose up --build then deploy");
    expect(c.sourceScript).toBe("latin");
    expect(c.languageMismatch).toBe(false);
  });

  it("flags an empty output (the generation pass produced nothing)", () => {
    expect(classifyGenerationQuality("המשתמש גר בתל אביב", "").emptyOutput).toBe(true);
    expect(classifyGenerationQuality("source", "   \n\t  ").emptyOutput).toBe(true);
  });

  it("an empty output is NOT a language mismatch (the two signals are disjoint)", () => {
    // An empty output has no script to compare — emptyOutput owns it, not languageMismatch.
    const c = classifyGenerationQuality("המשתמש גר בתל אביב", "");
    expect(c.emptyOutput).toBe(true);
    expect(c.languageMismatch).toBe(false);
  });

  it("is pure — same input yields the same classification (deterministic, no clock/IO)", () => {
    const a = classifyGenerationQuality("שלום עולם", "hello world");
    const b = classifyGenerationQuality("שלום עולם", "hello world");
    expect(a).toEqual(b);
  });
});
