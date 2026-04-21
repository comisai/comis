// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the 7-state ThinkingTagFilter FSM.
 *
 * Verifies that <think>, <thinking>, <thought>, <antThinking> blocks are
 * stripped from streaming deltas. Covers:
 * - All 4 thinking tag variants
 * - Default mode: thinking tags stripped, <final> passes through as text
 * - enforceFinalTag mode: only <final> content emitted
 * - Code-region protection: fenced and inline backtick blocks preserve tags
 * - Split boundary handling: tags split across multiple chunks
 * - returnState tracking: thinking blocks inside <final> return to inside_final
 * - flush() per-state behavior
 * - reset() restores correct initial state
 * - Case insensitivity
 */

import { describe, it, expect } from "vitest";
import { createThinkingTagFilter } from "./thinking-tag-filter.js";
import type { ThinkingTagFilter, ThinkingTagFilterOptions } from "./thinking-tag-filter.js";

/** Helper: feed multiple deltas and concatenate results (default mode). */
function feedAll(deltas: string[], options?: ThinkingTagFilterOptions): string {
  const filter = createThinkingTagFilter(options);
  let out = "";
  for (const d of deltas) {
    out += filter.feed(d);
  }
  out += filter.flush();
  return out;
}

describe("ThinkingTagFilter", () => {
  // ---------- Basic filtering (default mode) ----------

  describe("basic filtering (default mode)", () => {
    it("passes through normal text unchanged", () => {
      expect(feedAll(["Hello World"])).toBe("Hello World");
    });

    it("strips entire <think> block", () => {
      expect(feedAll(["<think>hidden</think>"])).toBe("");
    });

    it("preserves text around <think> block", () => {
      expect(feedAll(["before<think>hidden</think>after"])).toBe("beforeafter");
    });

    it("strips <thinking> block", () => {
      expect(feedAll(["<thinking>hidden</thinking>"])).toBe("");
    });

    it("strips <thought> block", () => {
      expect(feedAll(["<thought>hidden</thought>"])).toBe("");
    });

    it("strips <antThinking> block", () => {
      expect(feedAll(["<antThinking>hidden</antThinking>"])).toBe("");
    });

    it("passes <final> block through as text in default mode", () => {
      expect(feedAll(["<final>visible</final>"])).toBe("<final>visible</final>");
    });
  });

  // ---------- Split boundary tests ----------

  describe("split boundary handling", () => {
    it("handles tag split: <thi | nk>hidden</think>visible", () => {
      expect(feedAll(["<thi", "nk>hidden</think>visible"])).toBe("visible");
    });

    it("handles tag split: < | think>hidden</think>visible", () => {
      expect(feedAll(["<", "think>hidden</think>visible"])).toBe("visible");
    });

    it("handles content split across deltas", () => {
      expect(feedAll(["<think>hidd", "en</think>vis", "ible"])).toBe("visible");
    });

    it("handles closing tag split: </th | ink>visible", () => {
      expect(feedAll(["<think>hidden</th", "ink>visible"])).toBe("visible");
    });

    it("handles closing tag split: < | /think>visible", () => {
      expect(feedAll(["<think>hidden<", "/think>visible"])).toBe("visible");
    });

    it("handles <thinking> tag split across three deltas", () => {
      expect(feedAll(["before<thin", "king>hidden</thinkin", "g>after"])).toBe("beforeafter");
    });

    it("handles single character splits for opening tag", () => {
      expect(feedAll(["<", "t", "h", "i", "n", "k", ">", "hidden</think>ok"])).toBe("ok");
    });

    it("handles single character splits for closing tag", () => {
      expect(feedAll(["<think>x<", "/", "t", "h", "i", "n", "k", ">", "ok"])).toBe("ok");
    });
  });

  // ---------- Non-thinking tags ----------

  describe("non-thinking tags pass through", () => {
    it("passes through <div> tags", () => {
      expect(feedAll(["<div>content</div>"])).toBe("<div>content</div>");
    });

    it("passes through <other> tags", () => {
      expect(feedAll(["<other>text"])).toBe("<other>text");
    });

    it("passes through bare < characters", () => {
      expect(feedAll(["normal < text > here"])).toBe("normal < text > here");
    });

    it("passes through < followed by space", () => {
      expect(feedAll(["a < b"])).toBe("a < b");
    });

    it("passes through < at end of input via flush", () => {
      expect(feedAll(["text<"])).toBe("text<");
    });
  });

  // ---------- Multiple blocks ----------

  describe("multiple thinking blocks", () => {
    it("strips think block but passes final through in default mode", () => {
      expect(feedAll(["a<think>x</think>b<final>y</final>c"])).toBe("ab<final>y</final>c");
    });

    it("strips alternating think/thinking blocks", () => {
      expect(feedAll(["<think>a</think>mid<thinking>b</thinking>end"])).toBe("midend");
    });

    it("strips think followed immediately by another think", () => {
      expect(feedAll(["<think>a</think><think>b</think>visible"])).toBe("visible");
    });
  });

  // ---------- Case insensitivity ----------

  describe("case insensitivity", () => {
    it("strips <Think>...</Think>", () => {
      expect(feedAll(["<Think>hidden</Think>"])).toBe("");
    });

    it("strips <THINKING>...</THINKING>", () => {
      expect(feedAll(["<THINKING>hidden</THINKING>"])).toBe("");
    });

    it("strips <THOUGHT>...</THOUGHT>", () => {
      expect(feedAll(["<THOUGHT>hidden</THOUGHT>"])).toBe("");
    });

    it("strips <ANTTHINKING>...</ANTTHINKING>", () => {
      expect(feedAll(["<ANTTHINKING>hidden</ANTTHINKING>"])).toBe("");
    });

    it("passes <FINAL>...</FINAL> through in default mode", () => {
      expect(feedAll(["<FINAL>visible</FINAL>"])).toBe("<FINAL>visible</FINAL>");
    });

    it("strips mixed case <ThInKiNg>...</tHiNkInG>", () => {
      expect(feedAll(["<ThInKiNg>hidden</tHiNkInG>"])).toBe("");
    });
  });

  // ---------- Code-region protection ----------

  describe("code-region protection", () => {
    it("preserves inline code containing thinking tags", () => {
      expect(feedAll(["`<think>code</think>`"])).toBe("`<think>code</think>`");
    });

    it("preserves fenced code block containing thinking tags", () => {
      expect(feedAll(["```\n<think>code</think>\n```"])).toBe("```\n<think>code</think>\n```");
    });

    it("preserves fenced code block at start of stream", () => {
      expect(feedAll(["```\n<thinking>inside</thinking>\n```"])).toBe("```\n<thinking>inside</thinking>\n```");
    });

    it("strips tags outside code blocks but preserves inside", () => {
      expect(feedAll(["<think>hidden</think>`<think>kept</think>`"])).toBe("`<think>kept</think>`");
    });

    it("preserves inline code split across chunks", () => {
      expect(feedAll(["`<thi", "nk>code</think>`"])).toBe("`<think>code</think>`");
    });

    it("preserves fenced code block split across chunks", () => {
      expect(feedAll(["```\n<thin", "king>code</thinking>\n```"])).toBe("```\n<thinking>code</thinking>\n```");
    });

    it("exits fenced code block and resumes filtering", () => {
      expect(feedAll(["```\n<think>code</think>\n```\n<think>hidden</think>visible"])).toBe(
        "```\n<think>code</think>\n```\nvisible",
      );
    });

    it("handles inline code followed by tag to strip", () => {
      expect(feedAll(["`code`<think>hidden</think>after"])).toBe("`code`after");
    });
  });

  // ---------- enforceFinalTag mode ----------

  describe("enforceFinalTag mode", () => {
    it("suppresses text outside <final> blocks", () => {
      expect(feedAll(["thinking out loud<final>real answer</final>"], { enforceFinalTag: true })).toBe("real answer");
    });

    it("emits only <final> block content", () => {
      expect(feedAll(["<final>answer</final>"], { enforceFinalTag: true })).toBe("answer");
    });

    it("suppresses everything when no <final> tags present", () => {
      expect(feedAll(["no final tags here"], { enforceFinalTag: true })).toBe("");
    });

    it("concatenates multiple <final> blocks", () => {
      expect(feedAll(["<final>part1</final>noise<final>part2</final>"], { enforceFinalTag: true })).toBe("part1part2");
    });

    it("handles thinking block inside <final> with returnState", () => {
      expect(
        feedAll(["<final>answer<thinking>hidden</thinking>more</final>"], { enforceFinalTag: true }),
      ).toBe("answermore");
    });

    it("handles <final> split across chunks", () => {
      expect(feedAll(["<fin", "al>answer</final>"], { enforceFinalTag: true })).toBe("answer");
    });

    it("handles </final> split across chunks", () => {
      expect(feedAll(["<final>answer</fin", "al>rest"], { enforceFinalTag: true })).toBe("answer");
    });

    it("strips thinking tags even in suppressed context", () => {
      expect(feedAll(["<think>hidden</think><final>answer</final>"], { enforceFinalTag: true })).toBe("answer");
    });

    it("handles <thought> inside <final> block", () => {
      expect(
        feedAll(["<final>start<thought>inner</thought>end</final>"], { enforceFinalTag: true }),
      ).toBe("startend");
    });

    it("handles case-insensitive <FINAL> in enforceFinalTag mode", () => {
      expect(feedAll(["<FINAL>answer</FINAL>"], { enforceFinalTag: true })).toBe("answer");
    });
  });

  // ---------- returnState tracking ----------

  describe("returnState tracking", () => {
    it("returns to passthrough after thinking block in default mode", () => {
      expect(feedAll(["before<think>hidden</think>after"])).toBe("beforeafter");
    });

    it("returns to suppressed after thinking block in enforceFinalTag mode", () => {
      expect(feedAll(["<think>hidden</think>leaked?<final>answer</final>"], { enforceFinalTag: true })).toBe("answer");
    });

    it("returns to inside_final after thinking block inside <final>", () => {
      expect(
        feedAll(["<final>a<thinking>b</thinking>c</final>"], { enforceFinalTag: true }),
      ).toBe("ac");
    });

    it("handles multiple thinking blocks inside one <final> block", () => {
      expect(
        feedAll(["<final>x<think>1</think>y<thought>2</thought>z</final>"], { enforceFinalTag: true }),
      ).toBe("xyz");
    });
  });

  // ---------- flush() behavior ----------

  describe("flush behavior", () => {
    it("returns empty when no buffer (passthrough)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("hello");
      expect(filter.flush()).toBe("");
    });

    it("returns buffer for partial non-tag (buffering state)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("text");
      const partial = filter.feed("<oth");
      const flushed = filter.flush();
      expect(partial + flushed).toBe("<oth");
    });

    it("returns empty for unclosed thinking block (inside_block)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("<think>hidden content");
      expect(filter.flush()).toBe("");
    });

    it("returns empty for partial close tag in thinking block (close_buffering)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("<think>hidden</thi");
      expect(filter.flush()).toBe("");
    });

    it("returns empty when suppressed and no <final> seen (enforceFinalTag)", () => {
      const filter = createThinkingTagFilter({ enforceFinalTag: true });
      filter.feed("no final here");
      expect(filter.flush()).toBe("");
    });

    it("returns buffer for partial tag inside <final> (final_buffering)", () => {
      const filter = createThinkingTagFilter({ enforceFinalTag: true });
      const out = filter.feed("<final>text<oth");
      const flushed = filter.flush();
      expect(out + flushed).toBe("text<oth");
    });
  });

  // ---------- reset() behavior ----------

  describe("reset behavior", () => {
    it("clears state mid-block (default mode)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("<think>hidden");
      filter.reset();
      expect(filter.feed("visible")).toBe("visible");
    });

    it("clears buffering state (default mode)", () => {
      const filter = createThinkingTagFilter();
      filter.feed("<thi");
      filter.reset();
      expect(filter.feed("visible")).toBe("visible");
      expect(filter.flush()).toBe("");
    });

    it("restores suppressed initial state (enforceFinalTag mode)", () => {
      const filter = createThinkingTagFilter({ enforceFinalTag: true });
      filter.feed("<final>answer</final>");
      filter.reset();
      // After reset, should be back in suppressed state
      expect(filter.feed("should be suppressed")).toBe("");
    });

    it("clears code-region tracking on reset", () => {
      const filter = createThinkingTagFilter();
      filter.feed("`code");
      filter.reset();
      // After reset, <think> should be stripped (not preserved as code)
      expect(filter.feed("<think>hidden</think>visible") + filter.flush()).toBe("visible");
    });
  });

  // ---------- Edge cases ----------

  describe("edge cases", () => {
    it("handles empty delta", () => {
      const filter = createThinkingTagFilter();
      expect(filter.feed("")).toBe("");
    });

    it("handles self-closing-like <think/> by suppressing", () => {
      const filter = createThinkingTagFilter();
      const out = filter.feed("before<think/>after");
      const flushed = filter.flush();
      expect(out + flushed).toBe("before");
    });

    it("handles nested thinking tags", () => {
      expect(feedAll(["<think><thinking>nested</thinking></think>visible"])).toBe("visible");
    });

    it("handles very long non-tag buffer (exceeds MAX_BUFFER)", () => {
      // A < followed by 30 non-tag characters should flush as text
      const longTag = "<" + "x".repeat(30);
      expect(feedAll([longTag + "rest"])).toBe(longTag + "rest");
    });

    it("handles consecutive < characters", () => {
      expect(feedAll(["text<<more"])).toBe("text<<more");
    });
  });
});
