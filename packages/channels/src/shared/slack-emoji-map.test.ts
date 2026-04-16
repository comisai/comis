import { describe, expect, it } from "vitest";

import { EMOJI_SETS, type EmojiTier } from "./emoji-tier-map.js";
import { toSlackShortname, UNICODE_TO_SLACK } from "./slack-emoji-map.js";

describe("slack-emoji-map", () => {
  describe("UNICODE_TO_SLACK", () => {
    it("maps all unicode tier emoji to Slack shortnames", () => {
      for (const emoji of Object.values(EMOJI_SETS.unicode)) {
        expect(UNICODE_TO_SLACK.has(emoji)).toBe(true);
        const shortname = UNICODE_TO_SLACK.get(emoji)!;
        expect(typeof shortname).toBe("string");
        expect(shortname.length).toBeGreaterThan(0);
        // Slack shortnames should not contain colons
        expect(shortname).not.toContain(":");
      }
    });

    it("maps all platform tier emoji to Slack shortnames", () => {
      for (const emoji of Object.values(EMOJI_SETS.platform)) {
        expect(UNICODE_TO_SLACK.has(emoji)).toBe(true);
        const shortname = UNICODE_TO_SLACK.get(emoji)!;
        expect(typeof shortname).toBe("string");
        expect(shortname.length).toBeGreaterThan(0);
      }
    });

    it("maps specific emoji to expected shortnames", () => {
      expect(UNICODE_TO_SLACK.get("\u{1F440}")).toBe("eyes");
      expect(UNICODE_TO_SLACK.get("\u{1F914}")).toBe("thinking_face");
      expect(UNICODE_TO_SLACK.get("\u{1F50D}")).toBe("mag");
      expect(UNICODE_TO_SLACK.get("\u{1F527}")).toBe("wrench");
      expect(UNICODE_TO_SLACK.get("\u{1F4BB}")).toBe("computer");
      expect(UNICODE_TO_SLACK.get("\u{1F310}")).toBe("globe_with_meridians");
      expect(UNICODE_TO_SLACK.get("\u{1F3A8}")).toBe("art");
      expect(UNICODE_TO_SLACK.get("\u{2705}")).toBe("white_check_mark");
      expect(UNICODE_TO_SLACK.get("\u{274C}")).toBe("x");
      expect(UNICODE_TO_SLACK.get("\u{23F3}")).toBe("hourglass_flowing_sand");
      expect(UNICODE_TO_SLACK.get("\u{26A0}\u{FE0F}")).toBe("warning");
    });

    it("maps platform-specific emoji to expected shortnames", () => {
      expect(UNICODE_TO_SLACK.get("\u{1F9E0}")).toBe("brain");
      expect(UNICODE_TO_SLACK.get("\u{2699}\u{FE0F}")).toBe("gear");
      expect(UNICODE_TO_SLACK.get("\u{1F4DD}")).toBe("memo");
      expect(UNICODE_TO_SLACK.get("\u{1F578}\u{FE0F}")).toBe("spider_web");
      expect(UNICODE_TO_SLACK.get("\u{1F5BC}\u{FE0F}")).toBe("frame_with_picture");
      expect(UNICODE_TO_SLACK.get("\u{1F6A8}")).toBe("rotating_light");
    });

    it("has exactly 18 entries (all unique emoji across both tiers)", () => {
      expect(UNICODE_TO_SLACK.size).toBe(18);
    });
  });

  describe("toSlackShortname", () => {
    it("converts known Unicode emoji to Slack shortnames", () => {
      expect(toSlackShortname("\u{1F914}")).toBe("thinking_face");
      expect(toSlackShortname("\u{1F4BB}")).toBe("computer");
      expect(toSlackShortname("\u{2705}")).toBe("white_check_mark");
    });

    it("returns the input unchanged for unknown emoji", () => {
      const unknownEmoji = "\u{1F600}"; // grinning face -- not in lifecycle set
      expect(toSlackShortname(unknownEmoji)).toBe(unknownEmoji);
    });

    it("returns plain text unchanged", () => {
      expect(toSlackShortname("not-an-emoji")).toBe("not-an-emoji");
    });

    it("handles multi-codepoint emoji correctly", () => {
      // Warning sign with variation selector
      expect(toSlackShortname("\u{26A0}\u{FE0F}")).toBe("warning");
      // Gear with variation selector
      expect(toSlackShortname("\u{2699}\u{FE0F}")).toBe("gear");
    });
  });
});
