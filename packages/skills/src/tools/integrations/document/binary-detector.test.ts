// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isBinaryContent } from "./binary-detector.js";

describe("isBinaryContent", () => {
  it("returns false for plain ASCII text", () => {
    const buffer = Buffer.from("Hello, world! This is a plain text file.\n", "ascii");
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it("returns false for UTF-8 text with accented characters", () => {
    const buffer = Buffer.from("Héllo, wörld! Café résumé naïve fiancée.\n", "utf-8");
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it("returns true for buffer with null byte", () => {
    const buffer = Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x57, 0x6F, 0x72, 0x6C, 0x64]);
    expect(isBinaryContent(buffer)).toBe(true);
  });

  it("returns true for buffer with >10% non-printable control characters", () => {
    // 100 bytes: 15 control chars (0x01) + 85 printable = 15% non-printable
    const bytes: number[] = [];
    for (let i = 0; i < 85; i++) bytes.push(0x41); // 'A'
    for (let i = 0; i < 15; i++) bytes.push(0x01); // SOH control char
    const buffer = Buffer.from(bytes);
    expect(isBinaryContent(buffer)).toBe(true);
  });

  it("returns false for buffer with exactly 10% control characters (boundary)", () => {
    // 100 bytes: exactly 10 control chars = 10% ratio (not strictly > 10%)
    const bytes: number[] = [];
    for (let i = 0; i < 90; i++) bytes.push(0x41); // 'A'
    for (let i = 0; i < 10; i++) bytes.push(0x01); // SOH control char
    const buffer = Buffer.from(bytes);
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it("returns false for empty buffer", () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });

  it("returns false for buffer with only tabs and newlines", () => {
    const buffer = Buffer.from("\t\t\n\n\r\n\t\r\n", "ascii");
    expect(isBinaryContent(buffer)).toBe(false);
  });

  it("returns true for PNG magic header bytes", () => {
    // PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    // 0x89 is 137 decimal, > 0x7F so it's non-printable (high byte)
    // But more importantly, 0x1A (0x0E-0x1F range) counts as non-printable
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      // Pad with enough ASCII to make it detectable via null or ratio
    ]);
    // PNG has 0x00 bytes in the header chunk length field (IHDR chunk)
    const pngWithChunk = Buffer.concat([
      pngHeader,
      Buffer.from([0x00, 0x00, 0x00, 0x0D]), // chunk length = 13
    ]);
    expect(isBinaryContent(pngWithChunk)).toBe(true);
  });

  it("returns true for binary ELF header (Linux executable)", () => {
    // ELF magic: 0x7F 'E' 'L' 'F' followed by nulls
    const elfHeader = Buffer.from([
      0x7F, 0x45, 0x4C, 0x46, // ELF magic
      0x02, 0x01, 0x01, 0x00, // 64-bit, LE, ELF version, ELFOSABI_NONE
      0x00, 0x00, 0x00, 0x00, // padding (null bytes)
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(isBinaryContent(elfHeader)).toBe(true);
  });
});
