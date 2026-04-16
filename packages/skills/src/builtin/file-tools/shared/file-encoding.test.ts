import { describe, it, expect, afterAll } from "vitest";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  detectEncoding,
  stripBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  readFileWithMetadata,
  writeFilePreserving,
} from "./file-encoding.js";

describe("detectEncoding", () => {
  it("returns utf-16le for buffer starting with 0xFF 0xFE", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
    expect(detectEncoding(buf)).toBe("utf-16le");
  });

  it("returns utf-8 for buffer starting with UTF-8 BOM", () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x41]);
    expect(detectEncoding(buf)).toBe("utf-8");
  });

  it("returns utf-8 for buffer with no BOM", () => {
    const buf = Buffer.from([0x41, 0x42, 0x43]);
    expect(detectEncoding(buf)).toBe("utf-8");
  });

  it("returns utf-8 for empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(detectEncoding(buf)).toBe("utf-8");
  });

  it('returns "utf-8" for UTF-8 file with non-ASCII that chardet misidentifies as latin1', () => {
    // UTF-8 text with pound sign (U+00A3 → 0xC2 0xA3 in UTF-8).
    // chardet misidentifies this as ISO-8859-1 because the two-byte sequence
    // looks like isolated high bytes. The isValidUtf8 tiebreaker corrects this.
    const buf = Buffer.from(
      "Price: \u00A3100.00 for the item in the British store today only.",
      "utf-8",
    );
    expect(buf.length).toBeGreaterThanOrEqual(50);
    expect(detectEncoding(buf)).toBe("utf-8");
  });

  it('returns "latin1" for genuine Latin-1 file with isolated high bytes', () => {
    // French text with isolated high bytes (0xE9, 0xEA, 0xE7, 0xE8) that are NOT valid UTF-8
    const buf = Buffer.from(
      "Les op\xe9rations de p\xeache dans la r\xe9gion fran\xe7aise sont tr\xe8s importantes pour le pays.",
      "latin1",
    );
    expect(buf.length).toBeGreaterThanOrEqual(50);
    expect(detectEncoding(buf)).toBe("latin1");
  });
});

describe("stripBom", () => {
  it("strips U+FEFF from start of string", () => {
    expect(stripBom("\uFEFFhello")).toBe("hello");
  });

  it("returns string unchanged when no BOM", () => {
    expect(stripBom("hello")).toBe("hello");
  });

  it("returns empty string unchanged", () => {
    expect(stripBom("")).toBe("");
  });
});

describe("detectLineEnding", () => {
  it("returns crlf for CRLF content", () => {
    expect(detectLineEnding("hello\r\nworld")).toBe("crlf");
  });

  it("returns cr for CR-only content", () => {
    expect(detectLineEnding("hello\rworld")).toBe("cr");
  });

  it("returns lf for LF content", () => {
    expect(detectLineEnding("hello\nworld")).toBe("lf");
  });

  it("returns lf for content with no newlines", () => {
    expect(detectLineEnding("hello")).toBe("lf");
  });

  it("returns crlf when mixed CRLF and CR are present", () => {
    expect(detectLineEnding("a\r\nb\rc")).toBe("crlf");
  });
});

describe("normalizeToLF", () => {
  it("converts mixed line endings to LF", () => {
    expect(normalizeToLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("restoreLineEndings", () => {
  it("restores CRLF endings", () => {
    expect(restoreLineEndings("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
  });

  it("restores CR endings", () => {
    expect(restoreLineEndings("a\nb\n", "cr")).toBe("a\rb\r");
  });

  it("returns unchanged for LF", () => {
    expect(restoreLineEndings("a\nb\n", "lf")).toBe("a\nb\n");
  });

  it("round-trips CRLF content", () => {
    const original = "line1\r\nline2\r\nline3\r\n";
    const ending = detectLineEnding(original);
    const normalized = normalizeToLF(original);
    const restored = restoreLineEndings(normalized, ending);
    expect(restored).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Latin-1 encoding support
// ---------------------------------------------------------------------------

describe("Latin-1 encoding support", () => {
  const tempFiles: string[] = [];
  let tempDir: string;

  const getTempDir = async (): Promise<string> => {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), "latin1-test-"));
    }
    return tempDir;
  };

  const createTempFile = async (
    name: string,
    content: string | Buffer,
  ): Promise<string> => {
    const dir = await getTempDir();
    const filePath = join(dir, name);
    await writeFile(filePath, content);
    tempFiles.push(filePath);
    return filePath;
  };

  const createTempPath = async (name: string): Promise<string> => {
    const dir = await getTempDir();
    const filePath = join(dir, name);
    tempFiles.push(filePath);
    return filePath;
  };

  afterAll(async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  });

  it('detectEncoding returns "latin1" for Latin-1 buffer >= 50 bytes', () => {
    // Realistic French text with Latin-1 high bytes that chardet detects as ISO-8859-1
    const text = "Les op\xe9rations de p\xeache dans la r\xe9gion fran\xe7aise sont tr\xe8s importantes.";
    const buf = Buffer.from(text, "latin1");
    expect(buf.length).toBeGreaterThanOrEqual(50);
    expect(detectEncoding(buf)).toBe("latin1");
  });

  it('detectEncoding returns "utf-8" for short Latin-1 buffer (< 50 bytes)', () => {
    // A 30-byte buffer with a Latin-1 char -- too short for reliable detection
    const buf = Buffer.from([
      0x63, 0x61, 0x66, 0xe9, 0x0a, // "cafe\n"
      0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x61, 0x66, 0xe9, 0x0a,
      0x63, 0x61, 0x66, 0xe9, 0x0a,
    ]);
    expect(buf.length).toBeLessThan(50);
    expect(detectEncoding(buf)).toBe("utf-8");
  });

  // BOM priority: UTF-16LE BOM still wins even if content has Latin-1 chars
  it('detectEncoding still returns "utf-16le" when BOM present (BOM priority)', () => {
    const buf = Buffer.from([0xff, 0xfe, 0xe9, 0x00]);
    expect(detectEncoding(buf)).toBe("utf-16le");
  });

  it("writeFilePreserving writes Latin-1 encoded content", async () => {
    const tmpPath = await createTempPath("latin1-write.txt");
    await writeFilePreserving(tmpPath, "caf\u00E9\n", "latin1", "lf");
    const rawBuf = await readFile(tmpPath);

    // e-acute in Latin-1 is single byte 0xE9, NOT UTF-8's 0xC3 0xA9
    const eAcuteIndex = rawBuf.indexOf(0xe9);
    expect(eAcuteIndex).toBeGreaterThan(-1);
    // Verify it's single-byte (no 0xC3 before it)
    if (eAcuteIndex > 0) {
      expect(rawBuf[eAcuteIndex - 1]).not.toBe(0xc3);
    }
  });

  it("readFileWithMetadata + writeFilePreserving round-trip for Latin-1", async () => {
    // Write a Latin-1 file with known French text (chardet detects as ISO-8859-1)
    const text = "Les op\xe9rations de p\xeache dans la r\xe9gion fran\xe7aise sont tr\xe8s importantes.\n";
    const srcPath = await createTempFile(
      "latin1-roundtrip-src.txt",
      Buffer.from(text, "latin1"),
    );
    const origBuf = await readFile(srcPath);

    // Read with metadata
    const meta = await readFileWithMetadata(srcPath);
    expect(meta.encoding).toBe("latin1");

    // Write to second path
    const dstPath = await createTempPath("latin1-roundtrip-dst.txt");
    await writeFilePreserving(dstPath, meta.content, meta.encoding, meta.lineEnding);
    const dstBuf = await readFile(dstPath);

    // Raw buffers must be identical
    expect(Buffer.compare(origBuf, dstBuf)).toBe(0);
  });
});

describe("readFileWithMetadata", () => {
  const tempFiles: string[] = [];
  let tempDir: string;

  // Create a shared temp directory for all tests
  const getTempDir = async (): Promise<string> => {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), "file-encoding-test-"));
    }
    return tempDir;
  };

  const createTempFile = async (
    name: string,
    content: string | Buffer,
  ): Promise<string> => {
    const dir = await getTempDir();
    const filePath = join(dir, name);
    await writeFile(filePath, content);
    tempFiles.push(filePath);
    return filePath;
  };

  afterAll(async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  });

  it("reads a plain UTF-8 file with correct metadata", async () => {
    const text = "hello\nworld\n";
    const filePath = await createTempFile("plain-utf8.txt", text);
    const result = await readFileWithMetadata(filePath);

    expect(result.content).toBe(text);
    expect(result.encoding).toBe("utf-8");
    expect(result.lineEnding).toBe("lf");
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf-8"));
  });

  it("reads a UTF-8 BOM file with BOM stripped", async () => {
    const text = "\uFEFF" + "hello\nworld";
    const filePath = await createTempFile("utf8-bom.txt", text);
    const result = await readFileWithMetadata(filePath);

    expect(result.encoding).toBe("utf-8");
    expect(result.content).toBe("hello\nworld");
    expect(result.content.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf-8"));
  });

  it("reads a UTF-16LE BOM file with correct encoding and sizeBytes", async () => {
    const bom = Buffer.from([0xff, 0xfe]);
    const textContent = Buffer.from("hello\nworld", "utf16le");
    const buf = Buffer.concat([bom, textContent]);
    const filePath = await createTempFile("utf16le.txt", buf);
    const result = await readFileWithMetadata(filePath);

    expect(result.encoding).toBe("utf-16le");
    expect(result.content).toBe("hello\nworld");
    // sizeBytes is raw buffer length (2 bytes per char for ASCII in UTF-16LE + 2 byte BOM)
    expect(result.sizeBytes).toBe(buf.length);
  });

  it("reads a CRLF file with content normalized to LF", async () => {
    const text = "line1\r\nline2\r\n";
    const filePath = await createTempFile("crlf.txt", text);
    const result = await readFileWithMetadata(filePath);

    expect(result.lineEnding).toBe("crlf");
    expect(result.content).toBe("line1\nline2\n");
    expect(result.content).not.toContain("\r\n");
  });

  it("reads a CR-only file with content normalized to LF", async () => {
    const text = "line1\rline2\r";
    const filePath = await createTempFile("cr-only.txt", text);
    const result = await readFileWithMetadata(filePath);

    expect(result.lineEnding).toBe("cr");
    expect(result.content).toBe("line1\nline2\n");
    expect(result.content).not.toContain("\r");
  });

  it("round-trips UTF-8 file with non-ASCII characters correctly", async () => {
    // Uses pound sign which chardet misidentifies as ISO-8859-1 without the tiebreaker
    const content = "Price: \u00A3100.00 for the item in the British store today only.\n";
    const filePath = await createTempFile("utf8-pound.txt", content);
    const result = await readFileWithMetadata(filePath);

    expect(result.encoding).toBe("utf-8");
    // Pound sign is preserved, not corrupted by latin1 decode
    expect(result.content).toContain("\u00A3");
    // No mojibake — latin1 misinterpretation would split the 2-byte UTF-8 sequence
    expect(result.content).not.toMatch(/\u00C2\u00A3/);
  });

  it("reads an empty file with default metadata", async () => {
    const filePath = await createTempFile("empty.txt", "");
    const result = await readFileWithMetadata(filePath);

    expect(result.content).toBe("");
    expect(result.encoding).toBe("utf-8");
    expect(result.lineEnding).toBe("lf");
    expect(result.sizeBytes).toBe(0);
  });
});

describe("writeFilePreserving", () => {
  const tempFiles: string[] = [];
  let tempDir: string;

  const getTempDir = async (): Promise<string> => {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), "write-preserving-test-"));
    }
    return tempDir;
  };

  const createTempPath = async (name: string): Promise<string> => {
    const dir = await getTempDir();
    const filePath = join(dir, name);
    tempFiles.push(filePath);
    return filePath;
  };

  afterAll(async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  });

  it("writes UTF-8 content with LF endings correctly", async () => {
    const tmpPath = await createTempPath("utf8-lf.txt");
    await writeFilePreserving(tmpPath, "hello\nworld", "utf-8", "lf");
    const result = await readFileWithMetadata(tmpPath);

    expect(result.content).toBe("hello\nworld");
    expect(result.encoding).toBe("utf-8");
    expect(result.lineEnding).toBe("lf");
  });

  it("writes content with CRLF restoration", async () => {
    const tmpPath = await createTempPath("crlf-restore.txt");
    await writeFilePreserving(tmpPath, "line1\nline2", "utf-8", "crlf");
    const raw = await readFile(tmpPath, "utf-8");

    expect(raw).toBe("line1\r\nline2");
    const result = await readFileWithMetadata(tmpPath);
    expect(result.lineEnding).toBe("crlf");
  });

  it("writes content with CR restoration", async () => {
    const tmpPath = await createTempPath("cr-restore.txt");
    await writeFilePreserving(tmpPath, "line1\nline2", "utf-8", "cr");
    const raw = await readFile(tmpPath, "utf-8");

    expect(raw).toBe("line1\rline2");
    expect(raw).not.toContain("\r\n");
    const result = await readFileWithMetadata(tmpPath);
    expect(result.lineEnding).toBe("cr");
  });

  it("writes UTF-16LE with BOM", async () => {
    const tmpPath = await createTempPath("utf16le-bom.txt");
    await writeFilePreserving(tmpPath, "hello", "utf-16le", "lf");
    const rawBuf = await readFile(tmpPath);

    expect(rawBuf[0]).toBe(0xff);
    expect(rawBuf[1]).toBe(0xfe);
    const result = await readFileWithMetadata(tmpPath);
    expect(result.encoding).toBe("utf-16le");
    expect(result.content).toBe("hello");
  });

  it("does NOT restore UTF-8 BOM", async () => {
    const tmpPath = await createTempPath("no-utf8-bom.txt");
    await writeFilePreserving(tmpPath, "hello", "utf-8", "lf");
    const raw = await readFile(tmpPath, "utf-8");

    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(raw).toBe("hello");
  });

  it("round-trips a CRLF UTF-16LE file", async () => {
    const tmpPath = await createTempPath("roundtrip-utf16le-crlf.txt");
    // Create a CRLF UTF-16LE file manually
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from("a\r\nb\r\n", "utf16le");
    const original = Buffer.concat([bom, body]);
    const { writeFile: fsWriteFile } = await import("node:fs/promises");
    await fsWriteFile(tmpPath, original);

    // Read -> write -> read
    const first = await readFileWithMetadata(tmpPath);
    await writeFilePreserving(tmpPath, first.content, first.encoding, first.lineEnding);
    const second = await readFileWithMetadata(tmpPath);

    expect(second.content).toBe(first.content);
    expect(second.encoding).toBe(first.encoding);
    expect(second.lineEnding).toBe(first.lineEnding);
  });
});
