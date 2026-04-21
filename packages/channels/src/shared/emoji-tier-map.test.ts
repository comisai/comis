// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { ALL_PHASES, type LifecyclePhase } from "./lifecycle-state-machine.js";
import {
  classifyToolPhase,
  EMOJI_SETS,
  getEmojiForPhase,
  type DisplayablePhase,
  type EmojiTier,
} from "./emoji-tier-map.js";

describe("emoji-tier-map", () => {
  const DISPLAYABLE_PHASES: DisplayablePhase[] = [
    "queued",
    "thinking",
    "memory",
    "tool",
    "coding",
    "web",
    "media",
    "done",
    "error",
    "stall_soft",
    "stall_hard",
  ];

  const TIERS: EmojiTier[] = ["unicode", "platform", "custom"];

  describe("EMOJI_SETS", () => {
    it("has entries for all 3 tiers", () => {
      expect(Object.keys(EMOJI_SETS)).toHaveLength(3);
      for (const tier of TIERS) {
        expect(EMOJI_SETS).toHaveProperty(tier);
      }
    });

    it("maps all displayable phases (not idle) for each tier", () => {
      for (const tier of TIERS) {
        for (const phase of DISPLAYABLE_PHASES) {
          expect(EMOJI_SETS[tier]).toHaveProperty(phase);
          expect(typeof EMOJI_SETS[tier][phase]).toBe("string");
          expect(EMOJI_SETS[tier][phase].length).toBeGreaterThan(0);
        }
      }
    });

    it("does not include idle in any tier", () => {
      for (const tier of TIERS) {
        expect(EMOJI_SETS[tier]).not.toHaveProperty("idle");
      }
    });

    it("has distinct emoji for each phase within a tier", () => {
      for (const tier of TIERS) {
        const emojiValues = Object.values(EMOJI_SETS[tier]);
        const uniqueEmoji = new Set(emojiValues);
        expect(uniqueEmoji.size).toBe(emojiValues.length);
      }
    });

    it("custom tier matches unicode tier exactly", () => {
      for (const phase of DISPLAYABLE_PHASES) {
        expect(EMOJI_SETS.custom[phase]).toBe(EMOJI_SETS.unicode[phase]);
      }
    });

    it("platform tier differs from unicode for some phases", () => {
      const differences = DISPLAYABLE_PHASES.filter(
        (p) => EMOJI_SETS.platform[p] !== EMOJI_SETS.unicode[p],
      );
      expect(differences.length).toBeGreaterThan(0);
    });
  });

  describe("getEmojiForPhase", () => {
    it("returns undefined for idle phase", () => {
      for (const tier of TIERS) {
        expect(getEmojiForPhase("idle", tier)).toBeUndefined();
      }
    });

    it("returns a non-empty string for all displayable phases", () => {
      for (const tier of TIERS) {
        for (const phase of DISPLAYABLE_PHASES) {
          const emoji = getEmojiForPhase(phase, tier);
          expect(emoji).toBeDefined();
          expect(typeof emoji).toBe("string");
          expect(emoji!.length).toBeGreaterThan(0);
        }
      }
    });

    it("returns the correct emoji from EMOJI_SETS", () => {
      expect(getEmojiForPhase("thinking", "unicode")).toBe(EMOJI_SETS.unicode.thinking);
      expect(getEmojiForPhase("coding", "platform")).toBe(EMOJI_SETS.platform.coding);
      expect(getEmojiForPhase("done", "custom")).toBe(EMOJI_SETS.custom.done);
    });
  });

  describe("classifyToolPhase", () => {
    describe("coding tools", () => {
      it.each([
        "bash",
        "file_ops",
        "write",
        "edit",
        "read",
        "create_file",
        "apply_diff",
        "bash_exec",
        "edit_file",
      ])('classifies "%s" as coding', (tool) => {
        expect(classifyToolPhase(tool)).toBe("coding");
      });
    });

    describe("web tools", () => {
      it.each([
        "web_search",
        "browse",
        "fetch",
        "http",
        "url",
        "scrape",
        "web_search_google",
        "fetch_url",
      ])('classifies "%s" as web', (tool) => {
        expect(classifyToolPhase(tool)).toBe("web");
      });
    });

    describe("media tools", () => {
      it.each([
        "image",
        "vision",
        "audio",
        "transcribe",
        "tts",
        "speech",
        "video",
        "media",
        "sharp",
        "image_generate",
        "transcribe_audio",
      ])('classifies "%s" as media', (tool) => {
        expect(classifyToolPhase(tool)).toBe("media");
      });
    });

    describe("memory tools", () => {
      it.each([
        "memory_search",
        "memory_write",
        "memory_delete",
        "remember",
        "recall",
        "memory_search_semantic",
      ])('classifies "%s" as memory', (tool) => {
        expect(classifyToolPhase(tool)).toBe("memory");
      });
    });

    describe("generic tools", () => {
      it.each([
        "unknown_tool",
        "calculator",
        "translate",
        "calendar",
        "custom_mcp_tool",
        "process_data",
      ])('classifies "%s" as tool', (tool) => {
        expect(classifyToolPhase(tool)).toBe("tool");
      });
    });

    it("is case-insensitive", () => {
      expect(classifyToolPhase("BASH")).toBe("coding");
      expect(classifyToolPhase("Web_Search")).toBe("web");
      expect(classifyToolPhase("IMAGE")).toBe("media");
      expect(classifyToolPhase("Memory_Search")).toBe("memory");
    });

    it("matches on prefix only", () => {
      // "read" matches coding, not a partial match of some other word
      expect(classifyToolPhase("read_file_contents")).toBe("coding");
      expect(classifyToolPhase("readability_check")).toBe("coding");
    });
  });
});
