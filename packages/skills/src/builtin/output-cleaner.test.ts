import { describe, it, expect } from "vitest";
import { createOutputCleaner } from "./output-cleaner.js";

describe("createOutputCleaner", () => {
  describe("stateful TextDecoder", () => {
    it("decodes a complete single chunk normally", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("hello world");
      expect(cleaner.process(buf)).toBe("hello world");
    });

    it("decodes multi-byte UTF-8 split across two chunks", () => {
      // Checkmark U+2713 = \xe2\x9c\x93 (3 bytes)
      const full = Buffer.from("\xe2\x9c\x93", "binary");
      const chunk1 = full.subarray(0, 2); // first 2 bytes
      const chunk2 = full.subarray(2); // last byte

      const cleaner = createOutputCleaner();
      const out1 = cleaner.process(Buffer.from(chunk1));
      const out2 = cleaner.process(Buffer.from(chunk2));
      const combined = out1 + out2;
      // Must contain the checkmark, no U+FFFD replacement chars
      expect(combined).toContain("\u2713");
      expect(combined).not.toContain("\ufffd");
    });

    it("flush() emits any buffered incomplete sequence as replacement", () => {
      // Send only the first 2 bytes of a 3-byte sequence, then flush
      const partial = Buffer.from([0xe2, 0x9c]);
      const cleaner = createOutputCleaner();
      cleaner.process(partial);
      const flushed = cleaner.flush();
      // TextDecoder with fatal:false should emit replacement char on flush
      expect(flushed).toBe("\ufffd");
    });
  });

  describe("ANSI stripping", () => {
    it("strips SGR codes (colors)", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b[31mred\x1b[0m");
      expect(cleaner.process(buf)).toBe("red");
    });

    it("strips CSI cursor sequences", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b[2J\x1b[H");
      expect(cleaner.process(buf)).toBe("");
    });

    it("strips OSC sequences (BEL terminated)", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b]0;title\x07");
      expect(cleaner.process(buf)).toBe("");
    });

    it("strips OSC sequences (ST terminated)", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b]0;title\x1b\\");
      expect(cleaner.process(buf)).toBe("");
    });

    it("strips 256-color codes", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b[38;5;196mhello\x1b[0m");
      expect(cleaner.process(buf)).toBe("hello");
    });

    it("strips truecolor codes", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("\x1b[38;2;255;0;0mred\x1b[0m");
      expect(cleaner.process(buf)).toBe("red");
    });
  });

  describe("CR normalization", () => {
    it("collapses carriage return progress lines to final overwrite", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("loading...\rLoading...\rDone!");
      expect(cleaner.process(buf)).toBe("Done!");
    });

    it("handles per-line CR with newlines preserved", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("line1\nloading\rDone\nline3");
      expect(cleaner.process(buf)).toBe("line1\nDone\nline3");
    });

    it("passes through text with no CR unchanged", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("no carriage returns here");
      expect(cleaner.process(buf)).toBe("no carriage returns here");
    });

    it("preserves Windows CRLF line endings", () => {
      const cleaner = createOutputCleaner();
      // \r\n should be treated as line ending, not as CR overwrite
      const buf = Buffer.from("line1\r\nline2\r\nline3");
      expect(cleaner.process(buf)).toBe("line1\nline2\nline3");
    });
  });

  describe("binary sanitization", () => {
    it("strips NUL bytes", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("hello\x00world");
      expect(cleaner.process(buf)).toBe("helloworld");
    });

    it("strips non-printable control chars except tab, newline, CR", () => {
      const cleaner = createOutputCleaner();
      // \x01 = SOH, \x02 = STX, \x07 = BEL, \x08 = BS
      const buf = Buffer.from("a\x01b\x02c\x07d\x08e");
      expect(cleaner.process(buf)).toBe("abcde");
    });

    it("preserves tabs", () => {
      const cleaner = createOutputCleaner();
      const buf = Buffer.from("col1\tcol2\tcol3");
      expect(cleaner.process(buf)).toBe("col1\tcol2\tcol3");
    });
  });

  describe("pipeline composition", () => {
    it("composes all stages: ANSI + CR + binary in one chunk", () => {
      const cleaner = createOutputCleaner();
      // Colored progress with binary chars: "\x1b[32mloading\x00\rDone!\x1b[0m"
      const buf = Buffer.from("\x1b[32mloading\x00\rDone!\x1b[0m");
      expect(cleaner.process(buf)).toBe("Done!");
    });
  });

  describe("factory interface", () => {
    it("createOutputCleaner returns object with process and flush", () => {
      const cleaner = createOutputCleaner();
      expect(typeof cleaner.process).toBe("function");
      expect(typeof cleaner.flush).toBe("function");
    });
  });
});
