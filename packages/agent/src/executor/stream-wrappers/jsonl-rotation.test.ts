// SPDX-License-Identifier: Apache-2.0
/**
 * `jsonl-rotation.ts` unit tests.
 *
 * Coverage:
 *   - parseSizeBytes parses k/m/g suffixes and returns 0 on bad input.
 *   - rotateJsonlIfNeeded shifts files when over the cap.
 *   - appendJsonlLine writes a JSON line and triggers rotation.
 *
 * @module
 */
import {
  afterEach,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSizeBytes, rotateJsonlIfNeeded, appendJsonlLine } from "./jsonl-rotation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-jsonl-rotation-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => mkLogger()),
    level: "info",
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("parseSizeBytes", () => {
  it("parses raw bytes when no suffix is given", () => {
    expect(parseSizeBytes("1024")).toBe(1024);
  });
  it("parses k suffix as kibibytes", () => {
    expect(parseSizeBytes("5k")).toBe(5 * 1024);
  });
  it("parses m suffix as mebibytes (case-insensitive)", () => {
    expect(parseSizeBytes("3M")).toBe(3 * 1024 * 1024);
  });
  it("parses g suffix as gibibytes", () => {
    expect(parseSizeBytes("1g")).toBe(1024 * 1024 * 1024);
  });
  it("returns 0 when the string is unparseable", () => {
    expect(parseSizeBytes("garbage")).toBe(0);
  });
});

describe("rotateJsonlIfNeeded", () => {
  it("no-op when maxSize is undefined", () => {
    const logger = mkLogger();
    const filePath = join(tmpDir, "x.jsonl");
    writeFileSync(filePath, "x".repeat(2048));
    rotateJsonlIfNeeded(filePath, undefined, 3, logger);
    // File should be untouched.
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.1`)).toBe(false);
  });

  it("rotates when file exceeds size cap", () => {
    const logger = mkLogger();
    const filePath = join(tmpDir, "x.jsonl");
    writeFileSync(filePath, "x".repeat(2048)); // 2 KB
    rotateJsonlIfNeeded(filePath, "1k", 3, logger); // 1 KB cap
    expect(existsSync(filePath)).toBe(false); // moved to .1
    expect(existsSync(`${filePath}.1`)).toBe(true);
  });

  it("does not throw when file does not exist", () => {
    const logger = mkLogger();
    const filePath = join(tmpDir, "missing.jsonl");
    expect(() =>
      rotateJsonlIfNeeded(filePath, "1k", 3, logger),
    ).not.toThrow();
  });
});

describe("appendJsonlLine", () => {
  it("writes a single JSON object as one JSONL line", () => {
    const logger = mkLogger();
    const filePath = join(tmpDir, "out.jsonl");
    appendJsonlLine(filePath, { a: 1, b: "two" }, logger);
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toBe('{"a":1,"b":"two"}\n');
  });

  it("rotates when configured and the file exceeds the cap", () => {
    const logger = mkLogger();
    const filePath = join(tmpDir, "out.jsonl");
    writeFileSync(filePath, "x".repeat(2048));
    appendJsonlLine(filePath, { a: 1 }, logger, "1k", 2);
    // Original file rolled to .1; new content lives in the fresh .jsonl.
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe('{"a":1}\n');
  });

  it("logs a warn on disk error but does not throw", () => {
    const logger = mkLogger();
    // Use an invalid path that cannot be written.
    const filePath = "/nonexistent-root-dir/forbidden.jsonl";
    expect(() => appendJsonlLine(filePath, { a: 1 }, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
