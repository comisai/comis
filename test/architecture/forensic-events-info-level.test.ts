// SPDX-License-Identifier: Apache-2.0
/**
 * Forensic events INFO-level architecture test.
 *
 * The 7 forensic events that are O(1)/turn MUST emit at INFO so they
 * are visible when production daemons run at logLevel:"info". Any site
 * still at logger.debug for these messages is a regression — operators
 * lose the queue-layer signal needed to diagnose the duplicate-adapter
 * class of bugs.
 *
 * Shrink-only: NO allowlist. Every occurrence of each message string
 * must be adjacent to logger.info (allow logger?.info / deps.logger.info).
 * Any occurrence adjacent to logger.debug fails the test.
 *
 * Walker pattern mirrors test/architecture/trace-propagation.test.ts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * The 7 forensic messages and their authoritative source files.
 * Files are relative to REPO_ROOT.
 *
 * Three are ALREADY at INFO (trivially pass); four require promotion.
 * One ("Message dequeued") requires a NEW logger.info call to be added.
 */
interface ForensicSite {
  /** Human-readable event name for error messages. */
  readonly eventName: string;
  /** Source files to scan (relative to REPO_ROOT). */
  readonly files: readonly string[];
  /** The exact message string literal to find. */
  readonly message: string;
  /** If true, the message MUST appear at least once adjacent to .info( */
  readonly mustExistAtInfo: boolean;
}

const FORENSIC_SITES: readonly ForensicSite[] = [
  // ALREADY at INFO — trivially pass (DO NOT touch these files)
  {
    eventName: "Adapter registered",
    files: ["packages/orchestrator/src/channel-manager.ts"],
    message: "Adapter registered",
    mustExistAtInfo: true,
  },
  {
    eventName: "Execution started",
    files: ["packages/agent/src/executor/pi-executor/pi-executor.ts"],
    message: "Execution started",
    mustExistAtInfo: true,
  },
  {
    eventName: "Execution complete",
    files: ["packages/agent/src/executor/executor-post-execution.ts"],
    message: "Execution complete",
    mustExistAtInfo: true,
  },

  // DEBUG → INFO flips required
  {
    eventName: "Message enqueued",
    files: ["packages/orchestrator/src/queue/command-queue.ts"],
    message: "Message enqueued",
    mustExistAtInfo: true,
  },
  {
    eventName: "Message dequeued (NEW)",
    files: ["packages/orchestrator/src/queue/command-queue.ts"],
    message: "Message dequeued",
    mustExistAtInfo: true,
  },
  {
    eventName: "Memory store complete",
    files: ["packages/memory/src/sqlite-memory-adapter.ts"],
    message: "Memory store complete",
    mustExistAtInfo: true,
  },
  {
    eventName: "Outbound message",
    files: [
      "packages/channels/src/telegram/telegram-adapter/telegram-outbound.ts",
      "packages/channels/src/discord/discord-adapter.ts",
      "packages/channels/src/irc/irc-adapter.ts",
      "packages/channels/src/line/line-adapter.ts",
      "packages/channels/src/slack/slack-adapter.ts",
      "packages/channels/src/signal/signal-adapter.ts",
      "packages/channels/src/imessage/imessage-adapter.ts",
      "packages/channels/src/whatsapp/whatsapp-adapter.ts",
    ],
    message: "Outbound message",
    mustExistAtInfo: true,
  },
];

/**
 * Regex matching any logger call at INFO level.
 * Covers: logger.info, logger?.info, deps.logger.info, this.logger.info, etc.
 */
const INFO_TOKEN = /\blogger(?:\?)?\s*\.\s*info\s*\(/;

/**
 * Regex matching any logger call at DEBUG level.
 * Covers: logger.debug, logger?.debug, deps.logger.debug, this.logger.debug, etc.
 */
const DEBUG_TOKEN = /\blogger(?:\?)?\s*\.\s*debug\s*\(/;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Walk backward from the message-string line to find the enclosing logger
 * call. Look within LOOKBEHIND lines. Returns "info", "debug", or "unknown".
 */
/**
 * Large enough to cover even multi-hundred-line log payloads
 * (e.g. "Execution complete" in executor-post-execution.ts spans ~100 lines).
 * Bounded to avoid false positives from unrelated earlier calls.
 */
const LOOKBEHIND = 200;

function findEnclosingLevel(lines: readonly string[], messageLineIdx: number): "info" | "debug" | "unknown" {
  const start = Math.max(0, messageLineIdx - LOOKBEHIND);
  for (let i = messageLineIdx; i >= start; i--) {
    const line = lines[i] ?? "";
    if (INFO_TOKEN.test(line)) return "info";
    if (DEBUG_TOKEN.test(line)) return "debug";
  }
  return "unknown";
}

/**
 * Check a single source file for the given message string.
 * Returns violations (occurrences adjacent to .debug rather than .info).
 */
function checkFile(
  absPath: string,
  relPath: string,
  message: string,
): { violations: Violation[]; infoCount: number } {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    // File not found — caller handles mustExistAtInfo check
    return { violations: [], infoCount: 0 };
  }

  const lines = content.split(/\r?\n/);
  const violations: Violation[] = [];
  let infoCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Match the exact quoted message string
    if (!line.includes(`"${message}"`)) continue;
    // Skip comment lines
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    const level = findEnclosingLevel(lines, i);

    if (level === "info") {
      infoCount++;
    } else if (level === "debug") {
      violations.push({
        file: `${relPath}:${i + 1}`,
        line: i + 1,
        snippet: `${level}: ${line.trim().slice(0, 120)}`,
      });
    }
    // "unknown" — the message string appears but not adjacent to a logger call;
    // could be a comment or string constant. Skip silently.
  }

  return { violations, infoCount };
}

describe("forensic-events-info-level -- all 7 forensic events emit at INFO", () => {
  it("walker sanity: all source files resolve and contain message strings (pre-check)", () => {
    // Verify at least one forensic site has content (sanity that paths are right).
    const absPath = resolve(REPO_ROOT, "packages/orchestrator/src/channel-manager.ts");
    const content = readFileSync(absPath, "utf8");
    expect(content).toContain("Adapter registered");
  });

  for (const site of FORENSIC_SITES) {
    describe(`event: "${site.eventName}"`, () => {
      it(`no occurrence of "${site.message}" is adjacent to logger.debug`, () => {
        const allViolations: Violation[] = [];

        for (const relFile of site.files) {
          const absPath = resolve(REPO_ROOT, relFile);
          const { violations } = checkFile(absPath, relFile, site.message);
          allViolations.push(...violations);
        }

        expect(
          allViolations,
          formatViolations({
            description: `"${site.message}" (${site.eventName}) must emit at INFO, not DEBUG. Production daemons running at logLevel:"info" will miss this forensic event.`,
            violations: allViolations.map((v) => ({
              file: v.file,
              line: v.line,
              snippet: v.snippet,
            })),
            suggestedFix: `Change logger?.debug(...) → logger?.info(...) at the reported site(s). Do NOT change the payload or message string — level change only.`,
            designRef: "forensic O(1)/turn events emit at INFO so operators see them at logLevel:info",
          }),
        ).toEqual([]);
      });

      if (site.mustExistAtInfo) {
        it(`"${site.message}" appears at least once adjacent to logger.info across ${site.files.length} file(s)`, () => {
          let totalInfoCount = 0;

          for (const relFile of site.files) {
            const absPath = resolve(REPO_ROOT, relFile);
            const { infoCount } = checkFile(absPath, relFile, site.message);
            totalInfoCount += infoCount;
          }

          expect(
            totalInfoCount,
            formatViolations({
              description: `"${site.message}" (${site.eventName}) must exist as a logger.info call in the specified file(s). The log line is missing entirely.`,
              violations: site.files.map((f) => ({ file: f, line: 0, snippet: `Expected logger.info(..., "${site.message}")` })),
              suggestedFix: `Add a logger.info({...}, "${site.message}") call in the indicated file(s). For "Message dequeued": add it in executeLaneTask after the queue:dequeued bus emit in command-queue.ts.`,
              designRef: "forensic O(1)/turn events emit at INFO",
            }),
          ).toBeGreaterThan(0);
        });
      }
    });
  }
});
