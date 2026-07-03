// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveCompactionStrategy } from "./compaction-capability-router.js";

describe("resolveCompactionStrategy — capability-routed compaction", () => {
  describe("frontier and mid: always use llm (unchanged behavior)", () => {
    it("frontier, preferEviction=true → llm", () => {
      expect(resolveCompactionStrategy("frontier", true, "")).toBe("llm");
    });
    it("mid, preferEviction=true → llm", () => {
      expect(resolveCompactionStrategy("mid", true, "")).toBe("llm");
    });
    it("frontier, preferEviction=false → llm", () => {
      expect(resolveCompactionStrategy("frontier", false, "")).toBe("llm");
    });
  });

  describe("small/nano: prefer eviction by default", () => {
    it("small, preferEviction=true, no strongerModel → eviction", () => {
      expect(resolveCompactionStrategy("small", true, "")).toBe("eviction");
    });
    it("nano, preferEviction=true, no strongerModel → eviction", () => {
      expect(resolveCompactionStrategy("nano", true, "")).toBe("eviction");
    });
  });

  describe("opt-out: preferEviction=false restores llm", () => {
    it("small, preferEviction=false → llm (operator opt-out)", () => {
      expect(resolveCompactionStrategy("small", false, "")).toBe("llm");
    });
    it("nano, preferEviction=false → llm", () => {
      expect(resolveCompactionStrategy("nano", false, "")).toBe("llm");
    });
  });

  describe("stronger summarizer override", () => {
    it("small, preferEviction=true, strongerModel set → strong-summarizer", () => {
      expect(resolveCompactionStrategy("small", true, "ollama:qwen3.6:35b")).toBe("strong-summarizer");
    });
    it("nano, preferEviction=true, strongerModel set → strong-summarizer", () => {
      expect(resolveCompactionStrategy("nano", true, "anthropic:claude-3-5-haiku")).toBe("strong-summarizer");
    });
  });
});
