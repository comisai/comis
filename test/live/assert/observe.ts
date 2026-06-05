// SPDX-License-Identifier: Apache-2.0
/**
 * Observability-assertion library — typed matchers for the §7.5 assertion ladder.
 *
 * Implements rungs 1–5 (structural / observable side-effect / world-effect /
 * tool-call trace / retrieval quality) plus a rung-7 lint-discouragement
 * helper.  Every matcher is async and throws descriptively on failure.
 *
 * Usage in afterEach hooks:
 *   await expectCompletion({ agentId: "a1", hasDurationMs: true }, logCapture.getEntries().join("\n"));
 *   await expectNoSecretLeak(logLines);
 *   await expectHealthStable({}, logLines);
 *
 * Depends only on:
 *   - test/support/log-verifier.ts  (parseLogLines, LogEntry)
 *   - test/live/cost.ts             (assertNoSecrets)
 *
 * T-134-08: expectNoSecretLeak calls assertNoSecrets which redacts matched
 * values in thrown error messages — the secret itself never surfaces.
 *
 * @module
 */

import { parseLogLines, type LogEntry } from "../../support/log-verifier.js";
import { assertNoSecrets } from "../cost.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the obs.billing.total (and bySession/byAgent) RPC response.
 */
export interface BillingSnapshot {
  totalCost?: number;
  totalTokens?: number;
  callCount?: number;
  totalCacheSaved?: number;
}

/**
 * An event captured from the daemon's TypedEventBus.
 */
export interface ObservedEvent {
  name: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Partial deep-equality: every key in `subset` must match the corresponding
 * value in `target`.  Extra keys in `target` are ignored.
 */
function deepPartialMatch(target: Record<string, unknown>, subset: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(subset)) {
    const actual = target[key];
    if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
      if (typeof actual !== "object" || actual === null) return false;
      if (!deepPartialMatch(actual as Record<string, unknown>, expected as Record<string, unknown>)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rung 1 — Structural invariant: expectCompletion
// ---------------------------------------------------------------------------

/**
 * Assert that a completion log entry is present for the given agentId.
 *
 * Rung 1 (structural): deterministic; does not require a real LLM call.
 *
 * @param opts.agentId     - The agent identifier to match.
 * @param opts.hasDurationMs - When true, verifies the entry carries a numeric durationMs.
 * @param logLines         - NDJSON log output (one Pino JSON line per newline).
 */
export async function expectCompletion(
  opts: { agentId: string; hasDurationMs?: boolean },
  logLines: string,
): Promise<void> {
  const entries: LogEntry[] = parseLogLines(logLines);
  const matching = entries.filter(
    (e) =>
      (e["agentId"] as string | undefined) === opts.agentId &&
      typeof e.msg === "string" &&
      e.msg.toLowerCase().includes("completion"),
  );

  if (matching.length === 0) {
    throw new Error(
      `expectCompletion: no completion log entry found for agentId="${opts.agentId}". ` +
        `Searched ${entries.length} entries.`,
    );
  }

  if (opts.hasDurationMs) {
    const withDuration = matching.filter((e) => typeof e["durationMs"] === "number");
    if (withDuration.length === 0) {
      throw new Error(
        `expectCompletion: completion entry for agentId="${opts.agentId}" is missing durationMs. ` +
          `Entry: ${JSON.stringify(matching[0])}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rung 2 — Observable side-effect: expectCacheHit
// ---------------------------------------------------------------------------

/**
 * Assert that cache reads meet the minimum token threshold.
 *
 * Rung 2 (observable side-effect): reads the comis-cache-trace NDJSON stream.
 * Sums cacheReadInputTokens across all matching trace entries.
 *
 * @param opts.minReadTokens - Minimum total cacheReadInputTokens required.
 * @param cacheTraceLines    - NDJSON lines from the cache-trace stream.
 */
export async function expectCacheHit(
  opts: { minReadTokens: number },
  cacheTraceLines: string,
): Promise<void> {
  // Parse as generic objects (cache-trace lines are NDJSON but not Pino entries)
  const rawLines = cacheTraceLines
    .split("\n")
    .filter((l) => l.trim().length > 0);

  let totalReadTokens = 0;
  let traceCount = 0;

  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj["traceSchema"] === "comis-cache-trace") {
        traceCount++;
        const tokens = obj["cacheReadInputTokens"];
        if (typeof tokens === "number") {
          totalReadTokens += tokens;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  if (totalReadTokens < opts.minReadTokens) {
    throw new Error(
      `expectCacheHit: expected at least ${opts.minReadTokens} cacheReadInputTokens ` +
        `but found ${totalReadTokens} across ${traceCount} cache-trace entries.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rung 2 — Observable side-effect: expectNoErrorWithoutHint
// ---------------------------------------------------------------------------

/**
 * Assert that every ERROR or FATAL log entry carries both `hint` and `errorKind`.
 *
 * Rung 2 (observable side-effect / §2.7 matrix compliance):
 * Any error without these fields is a production-readiness defect.
 *
 * @param logLines - NDJSON log output.
 */
export async function expectNoErrorWithoutHint(logLines: string): Promise<void> {
  const entries = parseLogLines(logLines);
  const errors = entries.filter(
    (e) => e.level === "error" || e.level === "fatal",
  );

  const offenders = errors.filter(
    (e) =>
      typeof e["hint"] !== "string" ||
      (e["hint"] as string).trim().length === 0 ||
      typeof e["errorKind"] !== "string" ||
      (e["errorKind"] as string).trim().length === 0,
  );

  if (offenders.length > 0) {
    const descriptions = offenders
      .map((e) => `[${e.level}] "${e.msg}" (hint=${JSON.stringify(e["hint"])}, errorKind=${JSON.stringify(e["errorKind"])})`)
      .join("; ");
    throw new Error(
      `expectNoErrorWithoutHint: ${offenders.length} error/fatal log entr${offenders.length === 1 ? "y" : "ies"} ` +
        `missing hint or errorKind: ${descriptions}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rung 2 — Observable side-effect: expectBillingTokens
// ---------------------------------------------------------------------------

/**
 * Assert that billing metrics meet the specified minimums.
 *
 * Rung 2 (observable side-effect): reads the obs.billing.total RPC snapshot.
 *
 * @param opts.minTokens - Minimum totalTokens required (optional).
 * @param opts.minCost   - Minimum totalCost (USD) required (optional).
 * @param billing        - The BillingSnapshot from obs.billing RPC.
 */
export async function expectBillingTokens(
  opts: { minTokens?: number; minCost?: number },
  billing: BillingSnapshot,
): Promise<void> {
  const failures: string[] = [];

  if (opts.minTokens !== undefined) {
    const tokens = billing.totalTokens ?? 0;
    if (tokens < opts.minTokens) {
      failures.push(
        `totalTokens ${tokens} < minimum ${opts.minTokens}`,
      );
    }
  }

  if (opts.minCost !== undefined) {
    const cost = billing.totalCost ?? 0;
    if (cost < opts.minCost) {
      failures.push(
        `totalCost ${cost} < minimum ${opts.minCost}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `expectBillingTokens: billing assertions failed: ${failures.join("; ")}. ` +
        `Snapshot: ${JSON.stringify(billing)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rung 4 — Tool-call trace: expectEvent
// ---------------------------------------------------------------------------

/**
 * Assert that the event array contains a matching event.
 *
 * Rung 4 (tool-call trace): checks the TypedEventBus capture for a specific
 * event name and payload subset.
 *
 * @param eventName    - The event name to search for (e.g. "tool:executed").
 * @param payloadSubset - If provided, all keys must match the event's payload.
 * @param events       - Array of captured ObservedEvent objects.
 */
export async function expectEvent(
  eventName: string,
  payloadSubset: Record<string, unknown> | undefined,
  events: ObservedEvent[],
): Promise<void> {
  const candidates = events.filter((e) => e.name === eventName);

  if (candidates.length === 0) {
    throw new Error(
      `expectEvent: no event named "${eventName}" found. ` +
        `Available events: [${events.map((e) => e.name).join(", ")}]`,
    );
  }

  if (payloadSubset !== undefined) {
    const matched = candidates.find(
      (e) =>
        e.payload !== undefined &&
        deepPartialMatch(e.payload, payloadSubset),
    );
    if (!matched) {
      const payloads = candidates
        .map((e) => JSON.stringify(e.payload))
        .join("; ");
      throw new Error(
        `expectEvent: found ${candidates.length} event(s) named "${eventName}" ` +
          `but none matched payload subset ${JSON.stringify(payloadSubset)}. ` +
          `Actual payloads: ${payloads}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Security: expectNoSecretLeak
// ---------------------------------------------------------------------------

/**
 * Assert that no secret-shaped pattern appears in the provided log lines.
 *
 * Uses assertNoSecrets from cost.ts which redacts matched values in the thrown
 * error message — the secret itself never surfaces in the throw (T-134-08).
 *
 * @param logLines         - Array of raw log line strings.
 * @param additionalProbes - Optional extra strings to scan (e.g. config dumps).
 */
export async function expectNoSecretLeak(
  logLines: string[],
  additionalProbes?: string[],
): Promise<void> {
  const combined = logLines.join("\n");
  // assertNoSecrets throws with REDACTED values if any secret-shaped pattern found
  assertNoSecrets(combined, "daemon log");

  if (additionalProbes && additionalProbes.length > 0) {
    for (const probe of additionalProbes) {
      assertNoSecrets(probe, "additional probe");
    }
  }
}

// ---------------------------------------------------------------------------
// Rung 1 — Structural: expectHealthStable
// ---------------------------------------------------------------------------

/**
 * Assert that the daemon health line reports no instability.
 *
 * Rung 1 (structural invariant): the health line fields are model-independent
 * and always deterministic.
 *
 * @param opts.expectedDegradations - Provider names that are permitted to be degraded.
 * @param logLines                  - NDJSON log output.
 */
export async function expectHealthStable(
  opts: { expectedDegradations?: string[] },
  logLines: string,
): Promise<void> {
  const entries = parseLogLines(logLines);
  // Health line carries stuckSubAgentRuns or the canonical "Daemon health" msg
  const healthEntry = [...entries]
    .reverse()
    .find(
      (e) =>
        (typeof e.msg === "string" && e.msg.includes("Daemon health")) ||
        "stuckSubAgentRuns" in e,
    );

  if (!healthEntry) {
    throw new Error(
      `expectHealthStable: no health line found in ${entries.length} log entries. ` +
        `Ensure the daemon emits a periodic health log (check logLevel and daemon uptime).`,
    );
  }

  const violations: string[] = [];

  const stuck = healthEntry["stuckSubAgentRuns"];
  if (typeof stuck === "number" && stuck !== 0) {
    violations.push(`stuckSubAgentRuns=${stuck} (expected 0)`);
  }

  const dlq = healthEntry["deadLetterQueueSize"];
  if (typeof dlq === "number" && dlq !== 0) {
    violations.push(`deadLetterQueueSize=${dlq} (expected 0)`);
  }

  const timeouts = healthEntry["promptTimeoutsLast5m"];
  if (typeof timeouts === "number" && timeouts !== 0) {
    violations.push(`promptTimeoutsLast5m=${timeouts} (expected 0)`);
  }

  const degraded = healthEntry["degradedProviders"];
  if (Array.isArray(degraded) && degraded.length > 0) {
    const allowed = opts.expectedDegradations ?? [];
    const unexpected = (degraded as string[]).filter((p) => !allowed.includes(p));
    if (unexpected.length > 0) {
      violations.push(
        `degradedProviders contains unexpected entries: [${unexpected.join(", ")}]`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `expectHealthStable: health instability detected: ${violations.join("; ")}. ` +
        `Health entry: ${JSON.stringify(healthEntry)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rung 7 (DISCOURAGED) — rawTextEquality
// ---------------------------------------------------------------------------

/**
 * Lint-discouragement helper — emits a console.warn and returns without
 * performing any assertion.
 *
 * Per §7.5 of the assertion ladder, raw text equality is the weakest and most
 * brittle assertion form.  Prefer structural/side-effect/tool-trace matchers
 * at rungs 1–5.  This helper exists so callers can find the discouraged pattern
 * via grep and migrate it to a higher rung.
 *
 * T-134-10: does not affect runtime correctness — no throw, no side effect.
 *
 * @param _actual   - The actual text (intentionally unused).
 * @param _expected - The expected text (intentionally unused).
 */
export function rawTextEquality(_actual: string, _expected: string): void {
  console.warn(
    "[live-test rung-7 discouraged] rawTextEquality: prefer structural/side-effect/tool-trace assertions over raw text match. See §7.5 assertion ladder.",
  );
}
