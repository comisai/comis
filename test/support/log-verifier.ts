// SPDX-License-Identifier: Apache-2.0
/**
 * Log Verification Utility: Parse and assert on Pino structured JSON logs.
 *
 * Provides functions for parsing newline-delimited JSON log output,
 * matching entries by level/msg/arbitrary fields, and verifying ordered
 * log sequences. Used by integration tests across phases 27-36.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { Writable } from "node:stream";

import { LOG_POLL_MS, LOG_POLL_INTERVAL_MS } from "./timeouts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed Pino log entry. */
export interface LogEntry {
  level: string;
  levelValue: number;
  msg: string;
  time: string;
  name?: string;
  [key: string]: unknown;
}

/** Pattern for matching log entries. All fields are optional -- only specified fields are checked. */
export interface LogPattern {
  level?: string;
  msg?: string | RegExp;
  [key: string]: unknown;
}

/** Result from log assertion functions. */
export interface LogAssertionResult {
  matched: boolean;
  entry?: LogEntry;
  entries?: LogEntry[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse newline-delimited JSON log lines into LogEntry objects.
 *
 * - Splits input by newline
 * - Filters empty lines
 * - JSON.parse each line
 * - Skips lines that don't parse as JSON (e.g., pino-pretty output, stderr noise)
 */
export function parseLogLines(input: string): LogEntry[] {
  if (!input || input.trim().length === 0) return [];

  const lines = input.split("\n").filter((line) => line.trim().length > 0);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // Must have at least level and msg to be considered a valid Pino log entry
      if (typeof parsed === "object" && parsed !== null && "level" in parsed && "msg" in parsed) {
        entries.push(parsed as unknown as LogEntry);
      }
    } catch {
      // Skip non-JSON lines gracefully
    }
  }

  return entries;
}

/**
 * Parse a log file into LogEntry objects.
 */
export function parseLogFile(filePath: string): LogEntry[] {
  const content = readFileSync(filePath, "utf-8");
  return parseLogLines(content);
}

// ---------------------------------------------------------------------------
// Capture stream
// ---------------------------------------------------------------------------

/**
 * Create a Node.js Writable stream that captures Pino output in-process.
 *
 * Chunks are accumulated, split by newline, and parsed on demand.
 * `getEntries()` returns all parsed entries so far.
 */
export function createLogCapture(): {
  stream: Writable;
  getEntries: () => LogEntry[];
} {
  let buffer = "";

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      callback();
    },
  });

  function getEntries(): LogEntry[] {
    return parseLogLines(buffer);
  }

  return { stream, getEntries };
}

// ---------------------------------------------------------------------------
// Pattern matching (internal)
// ---------------------------------------------------------------------------

/**
 * Check if a single log entry matches a pattern.
 *
 * - String pattern.msg: exact substring match on entry.msg
 * - RegExp pattern.msg: regex test on entry.msg
 * - Other fields: deep equality check
 */
function matchesPattern(entry: LogEntry, pattern: LogPattern): boolean {
  for (const [key, expected] of Object.entries(pattern)) {
    if (expected === undefined) continue;

    const actual = entry[key];

    if (key === "msg") {
      if (expected instanceof RegExp) {
        if (typeof actual !== "string" || !expected.test(actual)) return false;
      } else if (typeof expected === "string") {
        if (typeof actual !== "string" || !actual.includes(expected)) return false;
      } else {
        if (actual !== expected) return false;
      }
    } else {
      // Deep equality for other fields
      if (!deepEqual(actual, expected)) return false;
    }
  }

  return true;
}

/**
 * Simple deep equality check for JSON-serializable values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Assertion functions
// ---------------------------------------------------------------------------

/**
 * Assert that at least one log entry matches the given pattern.
 *
 * Returns `{ matched: true, entry }` if found,
 * `{ matched: false, error }` if not.
 */
export function assertLogContains(entries: LogEntry[], pattern: LogPattern): LogAssertionResult {
  for (const entry of entries) {
    if (matchesPattern(entry, pattern)) {
      return { matched: true, entry };
    }
  }

  const patternDesc = JSON.stringify(pattern, (_key, value) =>
    value instanceof RegExp ? value.toString() : (value as unknown),
  );
  return {
    matched: false,
    error: `No log entry matches pattern: ${patternDesc}. Searched ${entries.length} entries.`,
  };
}

/**
 * Assert that patterns appear in order within entries (not necessarily adjacent).
 *
 * For each pattern, finds the first matching entry AFTER the previous match's index.
 * Returns `{ matched: true, entries: [...matched] }` if all found in order.
 * Returns `{ matched: false, error }` if sequence breaks.
 */
export function assertLogSequence(entries: LogEntry[], patterns: LogPattern[]): LogAssertionResult {
  if (patterns.length === 0) {
    return { matched: true, entries: [] };
  }

  const matched: LogEntry[] = [];
  let searchFrom = 0;

  for (let patternIdx = 0; patternIdx < patterns.length; patternIdx++) {
    const pattern = patterns[patternIdx]!;
    let found = false;

    for (let i = searchFrom; i < entries.length; i++) {
      if (matchesPattern(entries[i]!, pattern)) {
        matched.push(entries[i]!);
        searchFrom = i + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      const patternDesc = JSON.stringify(pattern, (_key, value) =>
        value instanceof RegExp ? value.toString() : (value as unknown),
      );
      return {
        matched: false,
        error: `Pattern ${patternIdx} not found after index ${searchFrom}: ${patternDesc}`,
      };
    }
  }

  return { matched: true, entries: matched };
}

/**
 * Return all entries matching the pattern (not just the first).
 */
export function filterLogs(entries: LogEntry[], pattern: LogPattern): LogEntry[] {
  return entries.filter((entry) => matchesPattern(entry, pattern));
}

// ---------------------------------------------------------------------------
// Polling-based log assertion
// ---------------------------------------------------------------------------

/**
 * Poll for a log entry matching `pattern` until it appears or timeout expires.
 *
 * Replaces fixed `setTimeout(200)` delays followed by manual assertion --
 * this version retries automatically so tests tolerate slow Pino async flushes
 * without unnecessary waiting on fast machines.
 *
 * @param getEntries - Callable that returns the current log entries (re-invoked each poll).
 * @param pattern    - The log pattern to search for.
 * @param options    - Optional timeout and poll interval overrides.
 * @returns The assertion result from the first successful match, or the final failed attempt.
 */
export async function waitForLogEntry(
  getEntries: () => LogEntry[],
  pattern: LogPattern,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<LogAssertionResult> {
  const timeout = options?.timeoutMs ?? LOG_POLL_MS;
  const interval = options?.pollIntervalMs ?? LOG_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const entries = getEntries();
    const result = assertLogContains(entries, pattern);
    if (result.matched) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  // Final attempt
  const entries = getEntries();
  return assertLogContains(entries, pattern);
}

// ---------------------------------------------------------------------------
// Temporal log window
// ---------------------------------------------------------------------------

/**
 * Create a temporal window over a log stream for per-test isolation.
 *
 * Call `mark()` at the start of each test (or setup) to record a timestamp.
 * `getWindowEntries()` returns only entries whose `time` field is >= the mark,
 * so earlier tests' log noise is excluded.
 *
 * @param getEntries - Callable that returns the full log entry list.
 */
export function createLogWindow(
  getEntries: () => LogEntry[],
): { mark: () => void; getWindowEntries: () => LogEntry[] } {
  let windowStart = new Date().toISOString();

  return {
    mark() {
      windowStart = new Date().toISOString();
    },
    getWindowEntries() {
      return getEntries().filter((entry) => entry.time >= windowStart);
    },
  };
}
