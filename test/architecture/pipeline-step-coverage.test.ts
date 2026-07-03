// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline step-tag coverage architecture test.
 *
 * Every known pipeline stage MUST emit at least one `step:`-tagged log line so that
 * operators can reliably filter daemon.log by stage:
 *
 *   jq 'select(.step=="queue-enqueue")' ~/.comis/daemon.log
 *
 * A duplicate-adapter bug would have been trivially findable with this filter.
 *
 * Shrink-only: NO allowlist. Every canonical emit site must carry a `step:` field.
 * Sites that cannot be tagged must be migrated — no exceptions.
 *
 * The 11 known stages:
 *   inbound, queue, execution, retry, delivery, memory, context, security, mcp, compaction, dedup
 *
 * Walker pattern mirrors test/architecture/forensic-events-info-level.test.ts.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// ---------------------------------------------------------------------------
// Closed STAGE_TOKEN_MAP (frozen; adding entries allowed, removing is a break)
// ---------------------------------------------------------------------------

/**
 * Authoritative mapping from stage name to accepted step: token values.
 * When an existing tag in the codebase maps to a stage, include it here.
 * "delivery" accepts "channels-outbound","block-delivery","chunking","delivery" because
 * execution-deliver.ts already emits step:"block-delivery" and step:"chunking".
 * "context" accepts "context","audio-preflight","media-compress","reset-trigger" because
 * resolve-and-preprocess.ts / inbound-gate.ts already emit those tags.
 * "security" accepts "security","response-filter","empty-response" because
 * execution-filter.ts already emits response-filter / empty-response.
 * "mcp" accepts "mcp","export-trajectory" because export-trajectory.ts already uses it.
 */
const STAGE_TOKEN_MAP = {
  inbound: ["channels-inbound", "channel-registry"] as const,
  queue: ["queue-enqueue", "queue-dequeue"] as const,
  execution: ["agent-execute"] as const,
  retry: ["retry"] as const,
  delivery: ["channels-outbound", "delivery", "block-delivery", "chunking"] as const,
  memory: ["memory-store"] as const,
  context: ["context", "audio-preflight", "media-compress", "reset-trigger"] as const,
  security: ["security", "response-filter", "empty-response", "outbound-media", "outbound-media-delivered"] as const,
  mcp: ["mcp", "export-trajectory"] as const,
  compaction: ["compaction"] as const,
  dedup: ["dedup"] as const,
} as const;

type KnownStage = keyof typeof STAGE_TOKEN_MAP;

const KNOWN_STAGES: readonly KnownStage[] = [
  "inbound",
  "queue",
  "execution",
  "retry",
  "delivery",
  "memory",
  "context",
  "security",
  "mcp",
  "compaction",
  "dedup",
];

// ---------------------------------------------------------------------------
// FORENSIC_STEP_SITES — 7 canonical forensic INFO events that MUST carry step:
// ---------------------------------------------------------------------------

interface ForensicStepSite {
  /** Human-readable event name for error messages. */
  readonly eventName: string;
  /** Source files to scan (relative to REPO_ROOT). */
  readonly files: readonly string[];
  /** The exact message string literal to find. */
  readonly message: string;
  /** The stage this site belongs to — used to pick the legal token set. */
  readonly stage: KnownStage;
}

const FORENSIC_STEP_SITES: readonly ForensicStepSite[] = [
  {
    eventName: "Adapter registered",
    files: ["packages/orchestrator/src/channel-manager.ts"],
    message: "Adapter registered",
    stage: "inbound",
  },
  {
    eventName: "Message enqueued",
    files: ["packages/orchestrator/src/queue/command-queue.ts"],
    message: "Message enqueued",
    stage: "queue",
  },
  {
    eventName: "Message dequeued",
    files: ["packages/orchestrator/src/queue/command-queue.ts"],
    message: "Message dequeued",
    stage: "queue",
  },
  {
    eventName: "Execution started",
    files: ["packages/agent/src/executor/pi-executor/pi-executor.ts"],
    message: "Execution started",
    stage: "execution",
  },
  {
    eventName: "Execution complete",
    files: ["packages/agent/src/executor/executor-post-execution.ts"],
    message: "Execution complete",
    stage: "execution",
  },
  {
    eventName: "Memory store complete",
    files: ["packages/memory/src/sqlite-memory-adapter.ts"],
    message: "Memory store complete",
    stage: "memory",
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
    stage: "delivery",
  },
];

// ---------------------------------------------------------------------------
// CHANNEL_INBOUND_SITES — 9 adapter "Inbound message" emit sites
// (echo-adapter excluded: it is a test-only in-memory stub with no logger)
// ---------------------------------------------------------------------------

interface ChannelInboundSite {
  readonly adapterName: string;
  readonly file: string;
  readonly message: string;
}

const CHANNEL_INBOUND_SITES: readonly ChannelInboundSite[] = [
  {
    adapterName: "discord",
    file: "packages/channels/src/discord/discord-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "telegram",
    file: "packages/channels/src/telegram/telegram-adapter/telegram-inbound.ts",
    message: "Inbound message",
  },
  {
    adapterName: "slack",
    file: "packages/channels/src/slack/slack-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "whatsapp",
    file: "packages/channels/src/whatsapp/whatsapp-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "signal",
    file: "packages/channels/src/signal/signal-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "line",
    file: "packages/channels/src/line/line-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "imessage",
    file: "packages/channels/src/imessage/imessage-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "irc",
    file: "packages/channels/src/irc/irc-adapter.ts",
    message: "Inbound message",
  },
  {
    adapterName: "email",
    file: "packages/channels/src/email/email-adapter.ts",
    message: "Inbound message",
  },
];

// ---------------------------------------------------------------------------
// Walker helpers
// ---------------------------------------------------------------------------

/**
 * Large enough to cover even multi-hundred-line log payloads
 * (e.g. "Execution complete" in executor-post-execution.ts spans ~100 lines).
 */
const LOOKBEHIND = 200;

/**
 * Regex matching any logger call at any level (info|warn|error|debug).
 * Covers: logger.info, logger?.info, deps.logger.info, this.logger.info, etc.
 */
const LOGGER_CALL_TOKEN = /\blogger(?:\?)?\s*\.\s*(?:info|warn|error|debug)\s*\(/;

/**
 * Check if `step: "<token>"` appears within LOOKBEHIND lines of the
 * message-string line, looking backward through the enclosing call.
 *
 * @param lines All source file lines.
 * @param messageLineIdx Index (0-based) of the line containing the message string.
 * @param legalTokens The set of token values that count as valid for this stage.
 * @returns The matched token, or null if none found.
 */
function findStepTagOnEnclosingCall(
  lines: readonly string[],
  messageLineIdx: number,
  legalTokens: readonly string[],
): string | null {
  const escapedTokens = legalTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tokenPattern = new RegExp(
    `\\bstep\\s*:\\s*"(${escapedTokens.join("|")})"`,
  );

  const start = Math.max(0, messageLineIdx - LOOKBEHIND);
  for (let i = messageLineIdx; i >= start; i--) {
    const line = lines[i] ?? "";
    const m = tokenPattern.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

interface StepViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Check a single source file for the given message string and assert that
 * each occurrence has a `step:` tag from the legal token set.
 */
function checkFileForStepTag(
  absPath: string,
  relPath: string,
  message: string,
  legalTokens: readonly string[],
): { violations: StepViolation[]; taggedCount: number } {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return { violations: [], taggedCount: 0 };
  }

  const lines = content.split(/\r?\n/);
  const violations: StepViolation[] = [];
  let taggedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes(`"${message}"`)) continue;
    // Skip comment lines and string constant assignments
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    )
      continue;
    // Skip lines that are not adjacent to a logger call within LOOKBEHIND
    const start = Math.max(0, i - LOOKBEHIND);
    let hasLoggerCall = false;
    for (let j = i; j >= start; j--) {
      if (LOGGER_CALL_TOKEN.test(lines[j] ?? "")) {
        hasLoggerCall = true;
        break;
      }
    }
    if (!hasLoggerCall) continue;

    const matched = findStepTagOnEnclosingCall(lines, i, legalTokens);
    if (matched) {
      taggedCount++;
    } else {
      violations.push({
        file: `${relPath}:${i + 1}`,
        line: i + 1,
        snippet: line.trim().slice(0, 120),
      });
    }
  }

  return { violations, taggedCount };
}

// ---------------------------------------------------------------------------
// Package walker: scan packages/*/src/**/*.ts (excluding .test.ts, dist/)
// ---------------------------------------------------------------------------

function collectSourceFiles(packagesRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Skip dist/ and node_modules/
        if (entry === "dist" || entry === "node_modules") continue;
        walk(full);
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".d.ts")
      ) {
        results.push(full);
      }
    }
  }

  // Walk each packages/*/src directory
  let pkgDirs: string[];
  try {
    pkgDirs = readdirSync(packagesRoot);
  } catch {
    return results;
  }

  for (const pkg of pkgDirs) {
    const srcDir = join(packagesRoot, pkg, "src");
    try {
      statSync(srcDir);
    } catch {
      continue;
    }
    walk(srcDir);
  }

  return results;
}

/**
 * Scan all packages-slash-star-slash-src source files (.ts, not .test.ts) for a logger call
 * that includes `step: "<token>"` where token is in the legal set.
 *
 * Returns true if at least one such call exists.
 */
function scanPackagesForStepToken(
  packagesRoot: string,
  legalTokens: readonly string[],
): { found: boolean; matchingFile: string | null } {
  const escapedTokens = legalTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Multi-line tolerant: step\s*:\s*"<token>" anywhere in the file
  const tokenPattern = new RegExp(
    `\\bstep\\s*:\\s*"(${escapedTokens.join("|")})"`,
  );

  const files = collectSourceFiles(packagesRoot);
  for (const absPath of files) {
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    if (tokenPattern.test(content)) {
      return { found: true, matchingFile: absPath };
    }
  }
  return { found: false, matchingFile: null };
}

const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const DESIGN_REF =
  "the pipeline step:-tag coverage rule (every pipeline stage emits at least one step:-tagged log line)";

// ===========================================================================
// Test suite 1: Each known pipeline stage has at least one step:-tagged emit
// ===========================================================================

describe("pipeline-step-coverage -- each known pipeline stage emits at least one step:-tagged log line", () => {
  it("walker sanity: packages/orchestrator/src/queue/command-queue.ts contains 'Message enqueued'", () => {
    const absPath = resolve(
      REPO_ROOT,
      "packages/orchestrator/src/queue/command-queue.ts",
    );
    const content = readFileSync(absPath, "utf8");
    expect(content).toContain("Message enqueued");
  });

  for (const stage of KNOWN_STAGES) {
    const tokens = STAGE_TOKEN_MAP[stage];

    it(`stage "${stage}" has at least one logger call with step: in [${tokens.join(", ")}]`, () => {
      const { found, matchingFile } = scanPackagesForStepToken(PACKAGES_ROOT, tokens);

      expect(
        found,
        formatViolations({
          description: `pipeline stage "${stage}" has no logger call emitting step:"<token>" where token ∈ [${tokens.join(", ")}]. Operators cannot filter daemon.log for this stage.`,
          violations: found
            ? []
            : [
                {
                  file: `packages/*/src/**/*.ts`,
                  line: 0,
                  snippet: `No logger.(info|warn|error|debug)({..., step: "<${tokens[0]}|...>"}, ...) found`,
                },
              ],
          suggestedFix: `Add step: "${tokens[0]}" to a canonical logger call in the "${stage}" pipeline stage. See AGENTS.md §2.7 for step: placement conventions.`,
          designRef: DESIGN_REF,
        }),
      ).toBe(true);
      // Suppress unused warning — matchingFile is informational
      void matchingFile;
    });
  }
});

// ===========================================================================
// Test suite 2: The 7 forensic INFO events carry step: tags
// ===========================================================================

describe("pipeline-step-coverage -- 7 forensic INFO events carry step: tags", () => {
  for (const site of FORENSIC_STEP_SITES) {
    const legalTokens = STAGE_TOKEN_MAP[site.stage];

    it(`"${site.eventName}" (${site.message}) carries step: ∈ [${legalTokens.join(", ")}]`, () => {
      const allViolations: StepViolation[] = [];
      let totalTagged = 0;

      for (const relFile of site.files) {
        const absPath = resolve(REPO_ROOT, relFile);
        const { violations, taggedCount } = checkFileForStepTag(
          absPath,
          relFile,
          site.message,
          legalTokens,
        );
        allViolations.push(...violations);
        totalTagged += taggedCount;
      }

      // Must have at least one tagged occurrence AND zero untagged occurrences
      expect(
        allViolations,
        formatViolations({
          description: `"${site.message}" (${site.eventName}) has logger calls WITHOUT step: ∈ [${legalTokens.join(", ")}] in ${site.files.join(", ")}.`,
          violations: allViolations.map((v) => ({
            file: v.file,
            line: v.line,
            snippet: v.snippet,
          })),
          suggestedFix: `Add step: "${legalTokens[0]}" to the logger.info/warn/error/debug payload at the reported site(s). Placement: first key after channelType (or at top if absent). See AGENTS.md §2.7.`,
          designRef: DESIGN_REF,
        }),
      ).toEqual([]);

      expect(
        totalTagged,
        formatViolations({
          description: `"${site.message}" (${site.eventName}) — no step:-tagged logger call found in ${site.files.join(", ")}.`,
          violations: site.files.map((f) => ({
            file: f,
            line: 0,
            snippet: `Expected logger call with step: "${legalTokens[0]}" adjacent to "${site.message}"`,
          })),
          suggestedFix: `Add step: "${legalTokens[0]}" to the logger call emitting "${site.message}". See AGENTS.md §2.7.`,
          designRef: DESIGN_REF,
        }),
      ).toBeGreaterThan(0);
    });
  }
});

// ===========================================================================
// Test suite 3: 9 channel-inbound sites carry step:"channels-inbound"
// ===========================================================================

describe('pipeline-step-coverage -- 9 channel-inbound "Inbound message" sites carry step:"channels-inbound"', () => {
  const inboundTokens = STAGE_TOKEN_MAP.inbound;

  for (const site of CHANNEL_INBOUND_SITES) {
    it(`${site.adapterName} adapter "Inbound message" log carries step: ∈ [${inboundTokens.join(", ")}]`, () => {
      const absPath = resolve(REPO_ROOT, site.file);
      const { violations, taggedCount } = checkFileForStepTag(
        absPath,
        site.file,
        site.message,
        inboundTokens,
      );

      expect(
        violations,
        formatViolations({
          description: `${site.adapterName} adapter "${site.message}" logger call is missing step: ∈ [${inboundTokens.join(", ")}]. Operators cannot filter inbound messages by adapter.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            snippet: v.snippet,
          })),
          suggestedFix: `Add step: "channels-inbound" to the logger.info payload at the reported site in ${site.file}. See AGENTS.md §2.7.`,
          designRef: DESIGN_REF,
        }),
      ).toEqual([]);

      expect(
        taggedCount,
        formatViolations({
          description: `${site.adapterName} adapter — no "Inbound message" logger call with step: found in ${site.file}.`,
          violations: [
            {
              file: site.file,
              line: 0,
              snippet: `Expected logger.info({..., step: "channels-inbound", ...}, "Inbound message")`,
            },
          ],
          suggestedFix: `Add step: "channels-inbound" to the logger.info({...}, "Inbound message") call in ${site.file}.`,
          designRef: DESIGN_REF,
        }),
      ).toBeGreaterThan(0);
    });
  }
});
