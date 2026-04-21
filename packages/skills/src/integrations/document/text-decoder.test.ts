// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { decodeTextBuffer } from "./text-decoder.js";
import iconv from "iconv-lite";

describe("decodeTextBuffer", () => {
  it("decodes plain UTF-8 text correctly", () => {
    const buffer = Buffer.from("Hello, world!", "utf-8");
    expect(decodeTextBuffer(buffer)).toBe("Hello, world!");
  });

  it("handles ASCII-only text without needing chardet", () => {
    const buffer = Buffer.from("Just ASCII text 0-9 A-Z a-z", "ascii");
    expect(decodeTextBuffer(buffer)).toBe("Just ASCII text 0-9 A-Z a-z");
  });

  it("handles empty buffer by returning empty string", () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toBe("");
  });

  describe("BOM handling", () => {
    it("strips UTF-8 BOM and decodes text correctly", () => {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const text = Buffer.from("Hello", "utf-8");
      const buffer = Buffer.concat([bom, text]);
      const result = decodeTextBuffer(buffer);
      expect(result).toBe("Hello");
      // BOM character (U+FEFF) must not be present
      expect(result).not.toContain("\uFEFF");
    });

    it("handles UTF-16 LE with BOM", () => {
      const bom = Buffer.from([0xFF, 0xFE]);
      const text = Buffer.from("Hi", "utf16le");
      const buffer = Buffer.concat([bom, text]);
      expect(decodeTextBuffer(buffer)).toBe("Hi");
    });

    it("handles UTF-16 BE with BOM", () => {
      const bom = Buffer.from([0xFE, 0xFF]);
      const text = iconv.encode("Hi", "utf16be");
      const buffer = Buffer.concat([bom, text]);
      expect(decodeTextBuffer(buffer)).toBe("Hi");
    });

    it("handles buffer with only UTF-8 BOM (empty content)", () => {
      const buffer = Buffer.from([0xEF, 0xBB, 0xBF]);
      expect(decodeTextBuffer(buffer)).toBe("");
    });

    it("handles buffer with only UTF-16 LE BOM (empty content)", () => {
      const buffer = Buffer.from([0xFF, 0xFE]);
      expect(decodeTextBuffer(buffer)).toBe("");
    });
  });

  describe("chardet encoding detection", () => {
    it("decodes ISO-8859-1 encoded text without replacement characters", () => {
      // Use a longer text so chardet has enough bytes to detect the encoding reliably.
      // Chardet needs ~50+ bytes of 8-bit content to distinguish encodings.
      const longIsoText =
        "Le café de Paris: résumé du menu croissant, beurré, fromage, pâté, île flottante, côte de bœuf";
      const buffer = iconv.encode(longIsoText, "latin1");
      const result = decodeTextBuffer(buffer);
      expect(result).toContain("caf");
      // Should not produce replacement character
      expect(result).not.toContain("\uFFFD");
    });

    it("decodes Shift_JIS encoded Japanese text", () => {
      // Use a longer string so chardet can distinguish Shift_JIS from windows-1252.
      const longJapanese = "日本語テスト 東京 大阪 京都 神戸 横浜 名古屋 福岡 札幌";
      const buffer = iconv.encode(longJapanese, "Shift_JIS");
      const result = decodeTextBuffer(buffer);
      expect(result).toContain("日本語");
    });
  });
});
