/**
 * Shared test helpers for CLI command tests.
 *
 * Provides reusable utilities to eliminate boilerplate: Commander program setup,
 * console spy factories, process.exit mocking, and spy output extraction.
 *
 * @module
 */

import { Command } from "commander";
import type { MockInstance } from "vitest";
import { vi } from "vitest";

/**
 * Create a Commander program with exitOverride already configured.
 *
 * Prevents Commander from calling process.exit on parse errors, instead throwing
 * a CommanderError that tests can catch.
 *
 * @returns A Command instance with exitOverride enabled
 */
export function createTestProgram(): Command {
  return new Command().exitOverride();
}

/**
 * Spy on console.log and console.error with automatic cleanup.
 *
 * Both spies suppress output by using empty mockImplementation. Call restore()
 * in afterEach or finally blocks to restore original console behavior.
 *
 * @returns Object with log spy, error spy, and restore function
 */
export function createConsoleSpy(): {
  log: MockInstance;
  error: MockInstance;
  restore: () => void;
} {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  return {
    log,
    error,
    restore() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

/**
 * Spy on process.exit to prevent actual termination during tests.
 *
 * The mock throws an Error("process.exit called") matching the existing test
 * pattern from agent.test.ts. Tests should catch this in try/catch.
 *
 * @returns Object with the exit spy and restore function
 */
export function createProcessExitSpy(): {
  spy: MockInstance;
  restore: () => void;
} {
  const spy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  return {
    spy,
    restore() {
      spy.mockRestore();
    },
  };
}

/**
 * Extract all captured output from a spy as a single string.
 *
 * Joins each call's arguments with spaces, then joins all calls with newlines.
 * Replaces the repeated inline pattern: spy.mock.calls.map(c => c.join(' ')).join('\\n')
 *
 * @param spy - A vitest MockInstance (e.g. from vi.spyOn)
 * @returns All captured output as a single string
 */
export function getSpyOutput(spy: MockInstance): string {
  return spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}
