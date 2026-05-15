// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for domain/rich-message.ts (COV-03 / Plan 40-11).
 *
 * Closes the 4 missing branch-paths:
 *   - parseRichButtons safeParse success vs. !success branches
 *   - parseRichCards safeParse success vs. !success branches
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { parseRichButtons, parseRichCards } from "./rich-message.js";

describe("parseRichButtons()", () => {
  it("returns ok result with the parsed button-rows array on valid input", () => {
    const result = parseRichButtons([
      [{ text: "Confirm", callback_data: "confirm-1" }],
      [
        { text: "Cancel", style: "danger" as const },
        { text: "Help", url: "https://example.com" },
      ],
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toHaveLength(1);
      expect(result.value[1]).toHaveLength(2);
    }
  });

  it("returns err result for malformed input that fails schema validation", () => {
    const result = parseRichButtons("not-an-array");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when a callback_data exceeds the 64-byte limit", () => {
    const longData = "a".repeat(100);
    const result = parseRichButtons([
      [{ text: "Btn", callback_data: longData }],
    ]);
    expect(result.ok).toBe(false);
  });

  it("returns ok result for an empty button-rows array", () => {
    const result = parseRichButtons([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});

describe("parseRichCards()", () => {
  it("returns ok result with the parsed cards array on valid input", () => {
    const result = parseRichCards([
      {
        title: "Card One",
        description: "Description text",
        color: 0x0099ff,
        fields: [{ name: "Field A", value: "Value A", inline: true }],
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.title).toBe("Card One");
    }
  });

  it("returns err result when input is not an array of cards", () => {
    const result = parseRichCards({ not: "an array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns err result when card image_url is not a valid URL", () => {
    const result = parseRichCards([{ image_url: "not-a-url" }]);
    expect(result.ok).toBe(false);
  });

  it("returns ok result for a card with nested button rows", () => {
    const result = parseRichCards([
      {
        title: "Interactive",
        buttons: [[{ text: "Click", callback_data: "k" }]],
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]!.buttons).toBeDefined();
    }
  });
});
