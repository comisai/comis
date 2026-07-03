// SPDX-License-Identifier: Apache-2.0
// Universal log-oracle — afterEach post-condition for every live test.
//
// FLUSH-SENTINEL REQUIREMENT (documented for test authors):
//   Before calling runLogOracle, the caller MUST flush the Pino transport:
//   1. Write a unique sentinel log line (e.g. logger.debug({sentinel:"end-<uuid>"})).
//   2. Poll logCapture.getEntries() until the sentinel appears.
//   See test/architecture/observability-flush-sentinels.test.ts for the pattern.
//   Failing to flush causes the last 1–2 lines to be silently missing (async Pino worker).
//
// 8-Battery checks run in sequence; throws on first failure.
//
// @module
/**
 * Options for the universal log-oracle.
 */
export interface LogOracleOptions {
  /** msg values (exact or substring match) exempt from check 2 */
  expectedErrors?: string[];
  /** provider names exempt from check 8 degradedProviders */
  expectedDegradations?: string[];
  /** billing snapshot for cross-stream token agreement (check 5) */
  billingSnapshot?: { totalTokens?: number };
}

import { parseLogLines } from "../../support/log-verifier.js";
import type { LogEntry } from "../../support/log-verifier.js";
import { CacheTraceEventSchema } from "@comis/observability";
import { scanForSecrets } from "../cost.js";

/**
 * Run the 8-battery log-oracle over a captured NDJSON log string.
 *
 * Throws on the first failing check with a descriptive message.
 * Resolves with void when all checks pass.
 *
 * @param logLines - Full NDJSON string from the captured Pino transport.
 * @param opts     - Per-test oracle options.
 */
export async function runLogOracle(
  logLines: string,
  opts?: LogOracleOptions,
): Promise<void> {
  const entries = parseLogLines(logLines);

  // ── Check 1: Parse + schema ───────────────────────────────────────────────
  // Every comis-cache-trace line must validate against CacheTraceEventSchema.
  for (const entry of entries) {
    if ((entry as Record<string, unknown>)["traceSchema"] === "comis-cache-trace") {
      const result = CacheTraceEventSchema.safeParse(entry);
      if (!result.success) {
        throw new Error(
          `[log-oracle check 1] Cache-trace schema violation: ${JSON.stringify(result.error.issues)}`,
        );
      }
    }
  }

  // ── Check 2: No unexpected ERROR/FATAL ───────────────────────────────────
  // Subtract expectedErrors by msg contains/equals; throw if any remain.
  const expectedErrors = opts?.expectedErrors ?? [];
  const errorEntries = entries.filter(
    (e) => e.level === "error" || e.level === "fatal",
  );
  const unexpectedErrors = errorEntries.filter((e) => {
    const msg = String(e.msg ?? "");
    return !expectedErrors.some(
      (expected) => msg === expected || msg.includes(expected),
    );
  });
  if (unexpectedErrors.length > 0) {
    throw new Error(
      `[log-oracle check 2] Unexpected ERROR/FATAL entries:\n${unexpectedErrors
        .map((e) => `  level=${e.level} msg=${String(e.msg)}`)
        .join("\n")}`,
    );
  }

  // ── Check 3: §2.7 matrix ─────────────────────────────────────────────────
  // Every WARN/ERROR must have hint:string (non-empty) + errorKind:string (non-empty).
  // Subtracted (expected) errors are excluded from this check too.
  const warnErrorEntries = entries.filter(
    (e) => e.level === "warn" || e.level === "error" || e.level === "fatal",
  );
  const matrixViolations: string[] = [];
  for (const e of warnErrorEntries) {
    // Skip entries that are in the expectedErrors list
    const msg = String(e.msg ?? "");
    const isExpected = expectedErrors.some(
      (expected) => msg === expected || msg.includes(expected),
    );
    if (isExpected) continue;

    const hint = (e as Record<string, unknown>)["hint"];
    const errorKind = (e as Record<string, unknown>)["errorKind"];
    if (typeof hint !== "string" || hint.length === 0) {
      matrixViolations.push(`  ${e.level} "${msg}": missing hint (got ${JSON.stringify(hint)})`);
    }
    if (typeof errorKind !== "string" || errorKind.length === 0) {
      matrixViolations.push(`  ${e.level} "${msg}": missing errorKind (got ${JSON.stringify(errorKind)})`);
    }
  }
  // Also check: INFO lines with "completion" in msg must have durationMs:number
  for (const e of entries) {
    if (
      e.level === "info" &&
      String(e.msg ?? "").toLowerCase().includes("completion")
    ) {
      const dur = (e as Record<string, unknown>)["durationMs"];
      if (typeof dur !== "number") {
        matrixViolations.push(
          `  info "${e.msg}": completion log missing durationMs (got ${JSON.stringify(dur)})`,
        );
      }
    }
  }
  if (matrixViolations.length > 0) {
    throw new Error(
      `[log-oracle check 3] §2.7 matrix violations:\n${matrixViolations.join("\n")}`,
    );
  }

  // ── Check 4: traceId continuity ──────────────────────────────────────────
  // traceId-bearing entries: find dominant traceId (mode). Warn on mismatches.
  const traceIdEntries = entries.filter(
    (e) => typeof (e as Record<string, unknown>)["traceId"] === "string",
  );
  if (traceIdEntries.length > 0) {
    const counts = new Map<string, number>();
    for (const e of traceIdEntries) {
      const tid = String((e as Record<string, unknown>)["traceId"]);
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    let dominant = "";
    let maxCount = 0;
    for (const [tid, count] of counts) {
      if (count > maxCount) { maxCount = count; dominant = tid; }
    }
    const orphans = traceIdEntries.filter(
      (e) => String((e as Record<string, unknown>)["traceId"]) !== dominant,
    );
    if (orphans.length > 0) {
      // Warn — not throw — to avoid false positives in Stage-A mocks
      console.warn(
        `[log-oracle check 4] traceId continuity: ${orphans.length} orphaned traceId(s) vs dominant "${dominant}"`,
      );
    }
  }

  // ── Check 5: Cross-stream token agreement ────────────────────────────────
  // Invariant: token disagreement THROWS (not warns) when billingSnapshot is provided.
  if (opts?.billingSnapshot?.totalTokens !== undefined) {
    const turnEntry = entries.find(
      (e) => (e as Record<string, unknown>)["event"] === "turn_completed",
    );
    if (turnEntry) {
      const logTokens = (turnEntry as Record<string, unknown>)["totalTokens"] as
        | number
        | undefined;
      if (logTokens !== undefined) {
        const expected = opts.billingSnapshot.totalTokens;
        const tolerance = Math.max(1, expected * 0.1);
        if (Math.abs(logTokens - expected) > tolerance) {
          throw new Error(
            `[log-oracle check 5] Cross-stream token mismatch: billingSnapshot.totalTokens=${expected}, session-index totalTokens=${logTokens} (>10% deviation)`,
          );
        }
      }
    }
  }

  // ── Check 6: Secret residency ─────────────────────────────────────────────
  // Scan the full raw log string for credential-shaped patterns.
  const secrets = scanForSecrets(logLines);
  if (secrets.length > 0) {
    throw new Error(
      `[log-oracle check 6] SECRET LEAK detected in log: ${secrets.map(() => "[REDACTED]").join(", ")}`,
    );
  }

  // ── Check 7: Level/payload hygiene ───────────────────────────────────────
  // Informational only: warn if zero step:-tagged DEBUG lines found.
  const hasStepLines = entries.some(
    (e) =>
      e.level === "debug" &&
      typeof (e as Record<string, unknown>)["step"] === "string",
  );
  if (entries.length > 0 && !hasStepLines) {
    console.warn(
      "[log-oracle check 7] No step:-tagged DEBUG lines found in log slice (pipeline coverage may be missing)",
    );
  }

  // ── Check 8: Health-line sanity ───────────────────────────────────────────
  // Find the most-recent entry with stuckSubAgentRuns field or msg containing "Daemon health".
  const healthEntries = entries.filter(
    (e) =>
      typeof (e as Record<string, unknown>)["stuckSubAgentRuns"] !== "undefined" ||
      String(e.msg ?? "").includes("Daemon health"),
  );
  if (healthEntries.length > 0) {
    const latest = healthEntries[healthEntries.length - 1] as Record<string, unknown> & LogEntry;
    const stuck = latest["stuckSubAgentRuns"];
    const dlq = latest["deadLetterQueueSize"];
    const timeouts = latest["promptTimeoutsLast5m"];
    const healthViolations: string[] = [];

    if (typeof stuck === "number" && stuck !== 0) {
      healthViolations.push(`stuckSubAgentRuns=${stuck} (expected 0)`);
    }
    if (typeof dlq === "number" && dlq !== 0) {
      healthViolations.push(`deadLetterQueueSize=${dlq} (expected 0)`);
    }
    if (typeof timeouts === "number" && timeouts !== 0) {
      healthViolations.push(`promptTimeoutsLast5m=${timeouts} (expected 0)`);
    }

    const expectedDegradations = opts?.expectedDegradations ?? [];
    const degraded = latest["degradedProviders"];
    if (Array.isArray(degraded) && degraded.length > 0) {
      const unexpected = (degraded as string[]).filter(
        (p) => !expectedDegradations.includes(p),
      );
      if (unexpected.length > 0) {
        healthViolations.push(
          `degradedProviders contains unexpected providers: ${unexpected.join(", ")}`,
        );
      }
    }

    if (healthViolations.length > 0) {
      throw new Error(
        `[log-oracle check 8] Health-line sanity violations:\n${healthViolations.map((v) => `  ${v}`).join("\n")}`,
      );
    }
  }
}
