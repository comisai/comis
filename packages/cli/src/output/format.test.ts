/**
 * Tests for CLI output format functions: status messages and JSON output.
 *
 * Verifies that success/error/warn/info write to correct streams (stdout vs stderr)
 * and that json() produces valid, parseable JSON output.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { createConsoleSpy, getSpyOutput } from "../test-helpers.js";
import { success, error, warn, info, json } from "./format.js";

describe("success/error/warn/info", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
  });

  it("success() writes to console.log with message", () => {
    consoleSpy = createConsoleSpy();
    success("Operation complete");
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Operation complete");
  });

  it("error() writes to console.error with message", () => {
    consoleSpy = createConsoleSpy();
    error("Something failed");
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Something failed");
    // error should NOT write to stdout
    expect(consoleSpy.log).not.toHaveBeenCalled();
  });

  it("warn() writes to console.log with message", () => {
    consoleSpy = createConsoleSpy();
    warn("Caution advised");
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("Caution advised");
  });

  it("info() writes to console.log with message", () => {
    consoleSpy = createConsoleSpy();
    info("FYI");
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("FYI");
  });

  it("success/warn/info do not write to stderr", () => {
    consoleSpy = createConsoleSpy();
    success("ok");
    warn("careful");
    info("note");
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it("error does not write to stdout", () => {
    consoleSpy = createConsoleSpy();
    error("bad thing");
    expect(consoleSpy.log).not.toHaveBeenCalled();
  });

  it("error() sanitizes API keys via sanitizeLogString", () => {
    consoleSpy = createConsoleSpy();
    error("Failed with key sk-1234567890abcdef1234567890abcdef");
    const errOutput = getSpyOutput(consoleSpy.error);
    // The raw API key should be redacted by sanitizeLogString
    expect(errOutput).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(errOutput).toContain("sk-[REDACTED]");
  });
});

describe("json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;

  afterEach(() => {
    consoleSpy?.restore();
  });

  it("json() produces valid JSON", () => {
    consoleSpy = createConsoleSpy();
    json({ name: "test", count: 42 });
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ name: "test", count: 42 });
  });

  it("json() pretty-prints with indentation", () => {
    consoleSpy = createConsoleSpy();
    json({ a: 1, b: 2 });
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("\n");
    expect(output).toContain("  ");
  });

  it("json() handles arrays", () => {
    consoleSpy = createConsoleSpy();
    json([1, 2, 3]);
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([1, 2, 3]);
  });

  it("json() handles null", () => {
    consoleSpy = createConsoleSpy();
    json(null);
    const output = getSpyOutput(consoleSpy.log);
    const parsed = JSON.parse(output);
    expect(parsed).toBeNull();
  });
});
