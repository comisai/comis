// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure named-key grammar behind `send_key`.
 *
 * Every expected value uses EXPLICIT hex/literal escapes so a wrong byte is a
 * visible diff (a wrong control byte is an invisible, load-bearing bug — the
 * agent thinks it pressed Ctrl-C; the program sees garbage).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { encodeKeyChord, encodeNamedKey } from "./terminal-key-grammar.js";

describe("terminal-key-grammar — literal keys", () => {
  it("maps Enter/Tab/Escape/Esc/Backspace/Space to their exact bytes", () => {
    expect(encodeNamedKey("Enter")).toBe("\r"); // \x0d
    expect(encodeNamedKey("Tab")).toBe("\t"); // \x09
    expect(encodeNamedKey("Escape")).toBe("\x1b");
    expect(encodeNamedKey("Esc")).toBe("\x1b");
    expect(encodeNamedKey("Backspace")).toBe("\x7f");
    expect(encodeNamedKey("Space")).toBe(" "); // \x20
  });
});

describe("terminal-key-grammar — arrows (CSI) + back-tab", () => {
  it("maps the four arrows to CSI sequences", () => {
    expect(encodeNamedKey("Up")).toBe("\x1b[A");
    expect(encodeNamedKey("Down")).toBe("\x1b[B");
    expect(encodeNamedKey("Right")).toBe("\x1b[C");
    expect(encodeNamedKey("Left")).toBe("\x1b[D");
  });

  it("maps S-Tab (back-tab) to CSI Z", () => {
    expect(encodeNamedKey("S-Tab")).toBe("\x1b[Z");
  });
});

describe("terminal-key-grammar — navigation keys", () => {
  it("maps Home/End/PageUp/PageDown/Delete/Insert", () => {
    expect(encodeNamedKey("Home")).toBe("\x1b[H");
    expect(encodeNamedKey("End")).toBe("\x1b[F");
    expect(encodeNamedKey("PageUp")).toBe("\x1b[5~");
    expect(encodeNamedKey("PageDown")).toBe("\x1b[6~");
    expect(encodeNamedKey("Delete")).toBe("\x1b[3~");
    expect(encodeNamedKey("Insert")).toBe("\x1b[2~");
  });
});

describe("terminal-key-grammar — control range (C-x)", () => {
  it("maps C-{a..z} to 0x01..0x1a (lowercased letter code - 0x60)", () => {
    expect(encodeNamedKey("C-a")).toBe("\x01");
    expect(encodeNamedKey("C-c")).toBe("\x03");
    expect(encodeNamedKey("C-d")).toBe("\x04");
    expect(encodeNamedKey("C-z")).toBe("\x1a");
  });

  it("maps C-[ to ESC (the canonical ESC alias)", () => {
    expect(encodeNamedKey("C-[")).toBe("\x1b");
  });

  it("treats an uppercase control letter the same as lowercase (C-C === C-c)", () => {
    expect(encodeNamedKey("C-C")).toBe("\x03");
  });
});

describe("terminal-key-grammar — function keys", () => {
  it("maps F1-F4 to SS3 (ESC O P..S)", () => {
    expect(encodeNamedKey("F1")).toBe("\x1bOP");
    expect(encodeNamedKey("F2")).toBe("\x1bOQ");
    expect(encodeNamedKey("F3")).toBe("\x1bOR");
    expect(encodeNamedKey("F4")).toBe("\x1bOS");
  });

  it("maps F5-F12 to CSI n ~", () => {
    expect(encodeNamedKey("F5")).toBe("\x1b[15~");
    expect(encodeNamedKey("F6")).toBe("\x1b[17~");
    expect(encodeNamedKey("F7")).toBe("\x1b[18~");
    expect(encodeNamedKey("F8")).toBe("\x1b[19~");
    expect(encodeNamedKey("F9")).toBe("\x1b[20~");
    expect(encodeNamedKey("F10")).toBe("\x1b[21~");
    expect(encodeNamedKey("F11")).toBe("\x1b[23~");
    expect(encodeNamedKey("F12")).toBe("\x1b[24~");
  });
});

describe("terminal-key-grammar — Alt/Meta modifier (ESC prefix)", () => {
  it("prefixes ESC before a printable for M-x and A-x", () => {
    expect(encodeNamedKey("M-x")).toBe("\x1bx");
    expect(encodeNamedKey("A-x")).toBe("\x1bx");
  });

  it("prefixes ESC before a named key's bytes for M-Up", () => {
    expect(encodeNamedKey("M-Up")).toBe("\x1b\x1b[A");
  });

  it("composes M- over a control key (M-C-c === ESC + C-c)", () => {
    expect(encodeNamedKey("M-C-c")).toBe("\x1b\x03");
  });

  it("rejects an Alt-wrapped multi-char garbage remainder (only a validated base is producible)", () => {
    expect(() => encodeNamedKey("M-Frobnicate")).toThrow(/invalid_value/);
  });
});

describe("terminal-key-grammar — bare printable passthrough", () => {
  it("passes a single printable char through literally", () => {
    expect(encodeNamedKey("a")).toBe("a");
    expect(encodeNamedKey("1")).toBe("1");
    expect(encodeNamedKey("/")).toBe("/");
  });
});

describe("terminal-key-grammar — unknown key rejection", () => {
  it("throws invalid_value for an unknown key name (never a silent no-op)", () => {
    expect(() => encodeNamedKey("Frobnicate")).toThrow(/invalid_value/);
  });

  it("never returns an empty string for an unknown key", () => {
    let result: string | undefined;
    try {
      result = encodeNamedKey("Frobnicate");
    } catch {
      result = undefined; // expected: it threw
    }
    expect(result).not.toBe("");
    expect(result).toBeUndefined();
  });

  it("rejects a multi-char non-name token (length > 1, not a recognized key)", () => {
    expect(() => encodeNamedKey("ab")).toThrow(/invalid_value/);
  });

  it("rejects a non-printable single char with no name", () => {
    // A raw control byte (0x07 BEL) is length-1 but outside 0x20..0x7e → rejected.
    expect(() => encodeNamedKey("\x07")).toThrow(/invalid_value/);
  });
});

describe("terminal-key-grammar — chord ordering", () => {
  it("concatenates each key's bytes in array order", () => {
    expect(encodeKeyChord(["Up", "Enter"])).toBe("\x1b[A\r");
    expect(encodeKeyChord(["C-c"])).toBe("\x03");
    expect(encodeKeyChord(["S-Tab"])).toBe("\x1b[Z");
  });

  it("encodes a longer chord left-to-right", () => {
    expect(encodeKeyChord(["a", "Left", "b"])).toBe("a\x1b[Db");
  });

  it("propagates an unknown-key throw from inside a chord", () => {
    expect(() => encodeKeyChord(["Up", "Frobnicate"])).toThrow(/invalid_value/);
  });

  it("encodes an empty chord to the empty string", () => {
    expect(encodeKeyChord([])).toBe("");
  });
});
