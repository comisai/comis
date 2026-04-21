// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for shared CLI test helpers.
 *
 * Verifies that each helper works correctly: createTestProgram configures
 * exitOverride, createConsoleSpy captures output, createProcessExitSpy
 * intercepts exit calls, and getSpyOutput extracts spy output.
 */

import { Command, CommanderError } from "commander";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "./test-helpers.js";

describe("createTestProgram", () => {
  it("returns a Command instance", () => {
    const program = createTestProgram();
    expect(program).toBeInstanceOf(Command);
  });

  it("has exitOverride enabled (throws CommanderError on unknown command)", () => {
    const program = createTestProgram();
    program.command("known");

    expect(() => program.parse(["node", "test", "unknown-cmd"])).toThrow(
      CommanderError,
    );
  });
});

describe("createConsoleSpy", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy> | undefined;

  afterEach(() => {
    consoleSpy?.restore();
    consoleSpy = undefined;
  });

  it("captures console.log output", () => {
    consoleSpy = createConsoleSpy();
    console.log("hello", "world");
    expect(consoleSpy.log).toHaveBeenCalledWith("hello", "world");
  });

  it("captures console.error output", () => {
    consoleSpy = createConsoleSpy();
    console.error("something went wrong");
    expect(consoleSpy.error).toHaveBeenCalledWith("something went wrong");
  });

  it("suppresses actual console output", () => {
    consoleSpy = createConsoleSpy();
    // If output were not suppressed, this would print to stderr/stdout
    console.log("suppressed");
    console.error("also suppressed");
    expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    expect(consoleSpy.error).toHaveBeenCalledTimes(1);
  });

  it("restore() restores original console behavior", () => {
    const originalLog = console.log;
    const originalError = console.error;
    consoleSpy = createConsoleSpy();

    expect(console.log).not.toBe(originalLog);
    expect(console.error).not.toBe(originalError);

    consoleSpy.restore();
    consoleSpy = undefined; // Prevent double restore in afterEach

    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
  });
});

describe("createProcessExitSpy", () => {
  let exitSpy: ReturnType<typeof createProcessExitSpy> | undefined;

  afterEach(() => {
    exitSpy?.restore();
    exitSpy = undefined;
  });

  it("causes process.exit to throw instead of terminating", () => {
    exitSpy = createProcessExitSpy();
    expect(() => process.exit(1)).toThrow("process.exit called");
  });

  it("restore() restores original process.exit", () => {
    const originalExit = process.exit;
    exitSpy = createProcessExitSpy();
    expect(process.exit).not.toBe(originalExit);

    exitSpy.restore();
    exitSpy = undefined; // Prevent double restore in afterEach

    expect(process.exit).toBe(originalExit);
  });
});

describe("getSpyOutput", () => {
  it("joins multiple calls into a single string", () => {
    const spy = vi.fn();
    spy("line one");
    spy("line two");
    spy("line three");

    expect(getSpyOutput(spy)).toBe("line one\nline two\nline three");
  });

  it("joins multiple arguments within a call with spaces", () => {
    const spy = vi.fn();
    spy("hello", "world");

    expect(getSpyOutput(spy)).toBe("hello world");
  });

  it("returns empty string for uncalled spy", () => {
    const spy = vi.fn();
    expect(getSpyOutput(spy)).toBe("");
  });

  it("handles mixed multi-arg and single-arg calls", () => {
    const spy = vi.fn();
    spy("Error:", "not found");
    spy("Done");

    expect(getSpyOutput(spy)).toBe("Error: not found\nDone");
  });
});
