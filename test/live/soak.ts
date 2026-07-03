// SPDX-License-Identifier: Apache-2.0
/**
 * The soak harness.
 *
 * Endurance/volume validation: drive the user-story library (`STORY_LIBRARY`)
 * as realistic traffic and WATCH the daemon health line for stability. Where the
 * journeys are about CORRECTNESS of real workflows, the soak is about
 * endurance under sustained traffic — and it REUSES the journeys as its traffic
 * generator.
 *
 * The health-line fields watched are the EXACT canonical "Daemon health" DEBUG
 * fields the daemon emits (packages/daemon/src/daemon.ts:1226-1240) — no invented
 * names: rssBytes / heapUsedBytes / eventLoopP99Ms / stuckSubAgentRuns /
 * deadLetterQueueSize / promptTimeoutsLast5m / degradedProviders.
 *
 * Sandbox vs operator split: `runSoak` + `parseHealthLine` + `assessHealthTrend`
 * are the harness; a SHORT deterministic smoke (scenarios/prove/soak-smoke.test.ts)
 * proves the mechanism on the echo Stage-B daemon. The REAL multi-hour soak is the
 * operator step on a Linux VPS — `runSoak` is what they invoke with
 * COMIS_LIVE + provider keys + many iterations over a long window.
 *
 * NO product change — additive test/live tooling.
 *
 * @module
 */

import { getStories } from "./journeys/registry.js";
import type { JourneyStep, UserStory } from "./journeys/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One per-iteration health snapshot parsed from the daemon "Daemon health" line. */
export interface HealthSample {
  iteration: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  eventLoopP99Ms?: number;
  stuckSubAgentRuns?: number;
  deadLetterQueueSize?: number;
  promptTimeoutsLast5m?: number;
  degradedProviders?: string[];
}

/** The minimal driver surface runSoak needs — a real ConversationDriver satisfies it. */
export interface SoakDriverLike {
  sendTurn(text: string): Promise<string>;
  capturedLogLines(): string;
}

/** Options for runSoak. */
export interface SoakOptions {
  driver: SoakDriverLike;
  /** Number of full traffic passes over the story set. */
  iterations: number;
  /** Traffic generator (default: the active STORY_LIBRARY stories). */
  stories?: UserStory[];
  /** Providers permitted to be degraded (failure-injection soaks); default none. */
  expectedDegradations?: string[];
  /** Trend thresholds (see assessHealthTrend). */
  trendOpts?: TrendOptions;
}

/** The soak run result. */
export interface SoakResult {
  iterations: number;
  /** True when every per-iteration sample + the across-iterations trend are stable. */
  healthy: boolean;
  samples: HealthSample[];
  /** Human-readable stability violations (empty when healthy). */
  violations: string[];
}

/** Thresholds for assessHealthTrend. */
export interface TrendOptions {
  /** Max allowed RSS/heap growth as a fraction of the first sample (default 0.5 = +50%). */
  rssGrowthTolerance?: number;
  /** Max allowed eventLoopP99Ms in any sample (default 1000ms). */
  eventLoopP99CapMs?: number;
}

// ---------------------------------------------------------------------------
// parseHealthLine — extract the LATEST "Daemon health" entry
// ---------------------------------------------------------------------------

/**
 * Parse the NDJSON log capture and return the LATEST "Daemon health" entry mapped
 * to the verified field set, or undefined when no health line is present.
 *
 * Mirrors the health-entry-finding logic in observe.ts `expectHealthStable`: an
 * entry is a health line when `msg === "Daemon health"` OR it carries an own
 * `stuckSubAgentRuns` key. Malformed lines are skipped (standard JSONL convention).
 */
export function parseHealthLine(logLines: string): HealthSample | undefined {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of logLines.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  const healthEntry = [...entries]
    .reverse()
    .find(
      (e) =>
        (typeof e["msg"] === "string" && (e["msg"] as string).includes("Daemon health")) ||
        "stuckSubAgentRuns" in e,
    );
  if (!healthEntry) return undefined;

  const num = (k: string): number | undefined =>
    typeof healthEntry[k] === "number" ? (healthEntry[k] as number) : undefined;

  return {
    iteration: 0,
    rssBytes: num("rssBytes"),
    heapUsedBytes: num("heapUsedBytes"),
    eventLoopP99Ms: num("eventLoopP99Ms"),
    stuckSubAgentRuns: num("stuckSubAgentRuns"),
    deadLetterQueueSize: num("deadLetterQueueSize"),
    promptTimeoutsLast5m: num("promptTimeoutsLast5m"),
    degradedProviders: Array.isArray(healthEntry["degradedProviders"])
      ? (healthEntry["degradedProviders"] as string[])
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// assessHealthTrend — across-iterations stability gate
// ---------------------------------------------------------------------------

/**
 * Assess the across-iterations stability of a soak run. STABLE requires:
 *   - no RSS/heap growth TREND beyond `rssGrowthTolerance` (last ≤ first × (1+tol));
 *   - every sample's `eventLoopP99Ms` ≤ `eventLoopP99CapMs`;
 *   - zero `stuckSubAgentRuns` / `deadLetterQueueSize` / `promptTimeoutsLast5m` in every sample;
 *   - empty `degradedProviders` in every sample.
 *
 * These are the soak stability criteria over the VERIFIED health-line fields.
 */
export function assessHealthTrend(
  samples: HealthSample[],
  opts?: TrendOptions,
): { stable: boolean; reason?: string } {
  const rssTol = opts?.rssGrowthTolerance ?? 0.5;
  const p99Cap = opts?.eventLoopP99CapMs ?? 1000;

  for (const s of samples) {
    if ((s.stuckSubAgentRuns ?? 0) !== 0) {
      return { stable: false, reason: `stuckSubAgentRuns=${s.stuckSubAgentRuns} at iteration ${s.iteration} (expected 0)` };
    }
    if ((s.deadLetterQueueSize ?? 0) !== 0) {
      return { stable: false, reason: `deadLetterQueueSize=${s.deadLetterQueueSize} at iteration ${s.iteration} (expected 0)` };
    }
    if ((s.promptTimeoutsLast5m ?? 0) !== 0) {
      return { stable: false, reason: `promptTimeoutsLast5m=${s.promptTimeoutsLast5m} at iteration ${s.iteration} (expected 0)` };
    }
    if (s.degradedProviders && s.degradedProviders.length > 0) {
      return { stable: false, reason: `degradedProviders [${s.degradedProviders.join(", ")}] at iteration ${s.iteration} (expected empty)` };
    }
    if (s.eventLoopP99Ms !== undefined && s.eventLoopP99Ms > p99Cap) {
      return { stable: false, reason: `eventLoopP99Ms=${s.eventLoopP99Ms} at iteration ${s.iteration} exceeds cap ${p99Cap}ms` };
    }
  }

  // RSS/heap growth trend — compare the last sample to the first (no runaway).
  const withRss = samples.filter((s) => typeof s.rssBytes === "number");
  if (withRss.length >= 2) {
    const first = withRss[0]!.rssBytes!;
    const last = withRss[withRss.length - 1]!.rssBytes!;
    if (first > 0 && last > first * (1 + rssTol)) {
      return { stable: false, reason: `RSS growth trend: ${first} → ${last} bytes exceeds +${Math.round(rssTol * 100)}% tolerance (possible leak)` };
    }
  }
  const withHeap = samples.filter((s) => typeof s.heapUsedBytes === "number");
  if (withHeap.length >= 2) {
    const first = withHeap[0]!.heapUsedBytes!;
    const last = withHeap[withHeap.length - 1]!.heapUsedBytes!;
    if (first > 0 && last > first * (1 + rssTol)) {
      return { stable: false, reason: `heap growth trend: ${first} → ${last} bytes exceeds +${Math.round(rssTol * 100)}% tolerance (possible leak)` };
    }
  }

  return { stable: true };
}

// ---------------------------------------------------------------------------
// runSoak — drive the journey library as traffic + watch the health line
// ---------------------------------------------------------------------------

/** Extract the text of each send_text step in a story (the soak traffic). */
function textStepsOf(story: UserStory): string[] {
  return story.steps
    .filter((s: JourneyStep): s is Extract<JourneyStep, { verb: "send_text" }> => s.verb === "send_text")
    .map((s) => s.text);
}

/**
 * Run a soak: `iterations` full passes over the traffic set, driving each story's
 * send_text steps through the driver, sampling the health line after each iteration,
 * then assessing the across-iterations trend.
 *
 * NEVER throws on a turn error — a tolerated provider error (dummy keys / a transient)
 * is caught so the soak completes (the §B idiom: the daemon still emits the streams).
 * Returns a SoakResult; `healthy` is false (with `violations`) on any instability.
 */
export async function runSoak(opts: SoakOptions): Promise<SoakResult> {
  const stories = opts.stories ?? getStories().filter((s) => s.status === "active");
  const samples: HealthSample[] = [];

  for (let i = 0; i < opts.iterations; i++) {
    for (const story of stories) {
      for (const text of textStepsOf(story)) {
        try {
          await opts.driver.sendTurn(text);
        } catch {
          // Tolerated: a dummy-key provider error / a transient. The daemon still
          // emitted its streams; the soak watches health, not turn success.
        }
      }
    }
    const sample = parseHealthLine(opts.driver.capturedLogLines());
    if (sample) samples.push({ ...sample, iteration: i });
  }

  const trend = assessHealthTrend(samples, opts.trendOpts);
  // expectedDegradations: subtract any permitted degraded providers before the gate.
  // (assessHealthTrend treats any degradedProviders as a violation; a failure-injection
  // soak can pre-filter them out of the samples it passes here. The default is none.)
  const allowed = new Set(opts.expectedDegradations ?? []);
  if (allowed.size > 0) {
    for (const s of samples) {
      if (s.degradedProviders) s.degradedProviders = s.degradedProviders.filter((p) => !allowed.has(p));
    }
  }
  const finalTrend = allowed.size > 0 ? assessHealthTrend(samples, opts.trendOpts) : trend;

  return {
    iterations: opts.iterations,
    healthy: finalTrend.stable,
    samples,
    violations: finalTrend.stable ? [] : [finalTrend.reason!],
  };
}
