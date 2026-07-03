// SPDX-License-Identifier: Apache-2.0
/**
 * Pure fleet-triage corpus loader + contract types.
 *
 * The deterministic by-hand-corpus half of the measure-first baseline. Everything here is
 * PURE except `readFileSync` (the loader): no daemon, no network, no env reads, no
 * key — so it runs keyless and never imports a product (`@comis/*`) package. The
 * loader is RED→GREEN unit-tested in fleet-triage-corpus.test.ts BEFORE the
 * gate script consumes it (the `--selftest` discipline), mirroring the
 * diagnosis-harness.ts loader half (the EXACT analog — the recordMetrics /
 * makeReadSourceTool / judge bits belong to that harness and are NOT mirrored here).
 *
 * CRITICAL DIVERGENCE: the corpus is an ENCODING of the already-written by-hand
 * fleet-health review, NOT a reconstruction from a rotating `daemon.1.log`. `loadCorpus`
 * reads a STATIC frozen `triage-corpus.json` the fixture layer writes; there is
 * no `trajectory.jsonl` to parse and no daemon to re-run. It is a transcription into
 * structured JSON, not a measurement.
 *
 * SECURITY: `parseJsonFile` rethrows with the PATH ONLY (the filename,
 * never the offending content) on a malformed fixture — the residency rule; a
 * committed fixture body could carry captured content, so it is never echoed. The
 * shape-guards reject a mis-shaped corpus at load time (with the file path) so it
 * cannot detonate downstream in the gate scorer as an opaque TypeError.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Contract types — the fixtures and gate-script layers import these.
// Closed string unions (never a bare `string` discriminator) — the as-const-union
// style of diagnosis-harness.ts.
// ---------------------------------------------------------------------------

/**
 * One fleet-triage signal from the by-hand review — the reference the
 * `obs.fleet.health` lens must reproduce. Carries counts + typed enums only, NEVER
 * raw log bodies (the review table is already PII-free).
 */
export interface FleetSignal {
  /** The signal class — a closed union, never a bare string. */
  signal:
    | "lcd-ingest-skipped"
    | "mcp-reconnect"
    | "budget-exceeded"
    | "config-posture"
    | "session-degradation"
    | "model-health-deferred";
  /** What the by-hand review found (the reference count). */
  byHandCount: number;
  /** Where the signal lands TODAY — the gap the recurrence gate measures. */
  location: "daemon.log" | "trajectory.jsonl" | "obs_diagnostics" | "native-stdout";
  /** Queryable cross-session today? (true = an ALREADY-STRUCTURED contrast item). */
  alreadyStructured: boolean;
  /** "precondition" (LCD) | "config" | "mcp" | … — optional descriptor. */
  errorKind?: string;
}

/**
 * The "cost/effort to beat" — the manual triage run by hand, encoded
 * as the RE-PROVE bar. The `obs.fleet.health` lens is proven when it
 * reproduces this consolidated list in ONE call.
 */
export interface ManualCostToBeat {
  /** The manual severity histogram over `daemon.log` (counts only). */
  severityHistogram: Record<string, number>;
  /** The manual group-by-message over `daemon.log` (message + count; no bodies). */
  groupByMessage: Array<{ message: string; count: number }>;
  /** The manual model-health scrape STEP described (NOT raw model output). */
  pm2ModelScrape: string;
}

/** A frozen corpus parsed into its signals + the manual cost-to-beat. */
export interface FleetCorpus {
  signals: FleetSignal[];
  manualCost: ManualCostToBeat;
}

// ---------------------------------------------------------------------------
// loadCorpus — read the frozen fixture directory into a typed bundle.
// ---------------------------------------------------------------------------

/**
 * The closed `signal` union, enumerated at runtime — the source of truth for the
 * shape-guard's membership check (it must stay in lockstep with the {@link FleetSignal}
 * `signal` union above). An out-of-enum value is rejected at load time so the README's
 * "an out-of-enum value fails the loader's shape-guard" claim is literally true and a
 * typo'd / stale signal name cannot reach the gate scorer as a spurious row.
 */
const SIGNAL_VALUES = new Set<FleetSignal["signal"]>([
  "lcd-ingest-skipped",
  "mcp-reconnect",
  "budget-exceeded",
  "config-posture",
  "session-degradation",
  "model-health-deferred",
]);

/** The closed `location` union, enumerated at runtime (twin of {@link SIGNAL_VALUES}). */
const LOCATION_VALUES = new Set<FleetSignal["location"]>([
  "daemon.log",
  "trajectory.jsonl",
  "obs_diagnostics",
  "native-stdout",
]);

/**
 * Parse a `{file}` under `dir` as JSON, rethrowing with the PATH ONLY (never the
 * offending content) on failure — the residency rule, mirroring
 * diagnosis-harness.ts.
 */
function parseJsonFile(dir: string, file: string): unknown {
  const raw = readFileSync(resolve(dir, file), "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    // Path only — never echo `raw`, which could carry captured content.
    throw new Error(`fleet-triage-corpus: malformed JSON in fixture file ${file}`);
  }
}

/**
 * Validate that a parsed `triage-corpus.json` has the load-bearing FleetSignal[]
 * shape, throwing PATH ONLY on violation (the assertAnswerKey analog in
 * diagnosis-harness.ts).
 *
 * Rejects: a `null`/non-object root, a non-`{signals:[]}` shape, an EMPTY signals array
 * (an empty corpus is a corrupt artifact — there are review findings to encode), a `null`/
 * non-object entry, any entry lacking a string `signal` / number `byHandCount` / string
 * `location` / boolean `alreadyStructured`, or any entry whose `signal`/`location` is a
 * string OUTSIDE the closed union. A JSON-valid-but-mis-shaped corpus would otherwise
 * pass parsing and then detonate downstream in the gate scorer with an opaque TypeError
 * and no fixture path (or, for an out-of-enum name, render as a silent spurious gate row).
 *
 * Each branch null/object-guards BEFORE dereferencing, so a bare `null` JSON literal or a
 * `[null]` entry hits this controlled PATH-NAMED throw, never the raw engine
 * `TypeError: Cannot read properties of null` the guard exists to replace.
 */
function assertSignals(parsed: unknown): FleetSignal[] {
  if (parsed === null || typeof parsed !== "object") {
    // Guard before dereferencing — a `null`/primitive root must not leak a raw TypeError.
    throw new Error("fleet-triage-corpus: malformed triage-corpus.json — not an object");
  }
  const signals = (parsed as { signals?: unknown }).signals;
  if (!Array.isArray(signals) || signals.length === 0) {
    // Path only — never echo the parsed body.
    throw new Error("fleet-triage-corpus: malformed triage-corpus.json — signals[] missing or empty");
  }
  for (const entry of signals) {
    if (entry === null || typeof entry !== "object") {
      // A `null` / primitive entry must not leak a raw TypeError on `entry.signal`.
      throw new Error(
        "fleet-triage-corpus: malformed triage-corpus.json — a signal entry is not an object",
      );
    }
    const s = entry as Partial<FleetSignal>;
    if (
      typeof s.signal !== "string" ||
      typeof s.byHandCount !== "number" ||
      typeof s.location !== "string" ||
      typeof s.alreadyStructured !== "boolean"
    ) {
      throw new Error(
        "fleet-triage-corpus: malformed triage-corpus.json — a signal entry lacks a load-bearing field",
      );
    }
    if (
      !SIGNAL_VALUES.has(s.signal as FleetSignal["signal"]) ||
      !LOCATION_VALUES.has(s.location as FleetSignal["location"])
    ) {
      // The closed-union contract (README + FleetSignal JSDoc): a typo'd / stale signal
      // or location name is a corrupt artifact, not a new gate row.
      throw new Error(
        "fleet-triage-corpus: malformed triage-corpus.json — signal/location out of the closed enum",
      );
    }
  }
  return signals as FleetSignal[];
}

/**
 * Validate that a parsed `manual-cost-to-beat.json` has the load-bearing
 * ManualCostToBeat shape, throwing PATH ONLY when `severityHistogram` /
 * `groupByMessage` / `pm2ModelScrape` are missing or wrong-typed.
 *
 * Null/object-guards the root before dereferencing, so a bare `null` JSON literal hits
 * this controlled PATH-NAMED throw, never a raw `TypeError` on `c.severityHistogram`.
 */
function assertManualCost(parsed: unknown): ManualCostToBeat {
  if (parsed === null || typeof parsed !== "object") {
    // Path only — guard before dereferencing a `null`/primitive root.
    throw new Error(
      "fleet-triage-corpus: malformed manual-cost-to-beat.json — not an object",
    );
  }
  const c = parsed as Partial<ManualCostToBeat>;
  if (
    typeof c.severityHistogram !== "object" ||
    c.severityHistogram === null ||
    !Array.isArray(c.groupByMessage) ||
    typeof c.pm2ModelScrape !== "string"
  ) {
    // Path only — never echo the parsed body.
    throw new Error(
      "fleet-triage-corpus: malformed manual-cost-to-beat.json — a load-bearing field is missing or mis-typed",
    );
  }
  return c as ManualCostToBeat;
}

/**
 * Read a frozen corpus directory (`triage-corpus.json` +
 * `manual-cost-to-beat.json`) into a {@link FleetCorpus}.
 *
 * Both files MUST be well-formed — a committed fixture is an artifact (the deliberate
 * early-throw philosophy from diagnosis-harness.ts). A malformed or
 * mis-shaped file throws PATH ONLY (the filename, never the body).
 */
export function loadCorpus(dir: string): FleetCorpus {
  return {
    signals: assertSignals(parseJsonFile(dir, "triage-corpus.json")),
    manualCost: assertManualCost(parseJsonFile(dir, "manual-cost-to-beat.json")),
  };
}
